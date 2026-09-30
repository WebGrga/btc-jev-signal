/// <reference types="@cloudflare/workers-types" />

import { buildDashboardData } from "./dashboard-data.js";
import { buildCloudflareExperimentState, fetchCloudflareAlignedClose, fetchCloudflarePaperCandles } from "./cloudflare-market.js";
import { assessPaperTradeCandidate, decidePaperTrade, makePaperTradeScan } from "./paper-trade.js";
import { advancePaperTrade } from "./paper-simulator.js";
import { parseTypesafeDailyRequestLimit, utcDay } from "./cloudflare-cost-guard.js";
import {
  appendCloudflarePaperTradeScan,
  appendCloudflareSettlement,
  claimScheduledBoundary,
  countTypesafeRequests,
  hasCloudflarePaperTradeScan,
  hasActivePaperTrade,
  isCollectionPaused,
  loadActivePaperTrades,
  loadCloudflareBatches,
  loadCloudflareSettlements,
  reserveTypesafeRequest,
  saveCloudflarePaperTrade,
  updateScheduledBoundary,
} from "./cloudflare-store.js";
import type { ActualDirection, Forecast, Settlement } from "./experiment-types.js";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TYPESAFE_API_KEY: string;
  TYPESAFE_DAILY_REQUEST_LIMIT?: string;
  LIQUIDATION_WINDOW_MS?: string;
  PAPER_TRADE_NOTIONAL_USD?: string;
}

const FIFTEEN_MINUTES_MS = 15 * 60_000;
const SETTLEMENT_GRACE_MS = 5_000;

function round(value: number, digits = 6): number { return Number(value.toFixed(digits)); }
function actualDirection(origin: number, target: number): ActualDirection {
  if (target > origin) return "higher";
  if (target < origin) return "lower";
  return "unchanged";
}

function settlementFor(forecast: Forecast, targetPrice: number): Settlement {
  const actual = actualDirection(forecast.origin_price_usdt, targetPrice);
  const scorable = actual !== "unchanged";
  const probability = scorable ? forecast.probabilities[actual] : null;
  return {
    forecast_id: forecast.forecast_id,
    horizon: forecast.horizon,
    origin_timestamp_utc: forecast.origin_timestamp_utc,
    target_timestamp_utc: forecast.target_timestamp_utc,
    settled_at_utc: new Date().toISOString(),
    origin_price_usdt: forecast.origin_price_usdt,
    target_price_usdt: targetPrice,
    actual_return_pct: round((targetPrice / forecast.origin_price_usdt - 1) * 100),
    predicted_direction: forecast.choice,
    actual_direction: actual,
    correct: scorable ? forecast.choice === actual : null,
    predicted_probability: probability,
    brier_score: scorable ? round((forecast.probabilities.higher - (actual === "higher" ? 1 : 0)) ** 2) : null,
    log_loss: probability === null ? null : round(-Math.log(Math.max(1e-12, probability))),
    target_price_source: "Kraken Spot completed BTC/USD 1m candle close",
  };
}

async function settleDue(env: Env, nowMs: number): Promise<number> {
  const [batches, settlements] = await Promise.all([
    loadCloudflareBatches(env.DB),
    loadCloudflareSettlements(env.DB),
  ]);
  const settledIds = new Set(settlements.map((settlement) => settlement.forecast_id));
  const due = batches.flatMap((batch) => batch.forecasts).filter((forecast) =>
    !settledIds.has(forecast.forecast_id) && Date.parse(forecast.target_timestamp_utc) + SETTLEMENT_GRACE_MS <= nowMs,
  );
  const groups = new Map<string, Forecast[]>();
  for (const forecast of due) groups.set(forecast.target_timestamp_utc, [...(groups.get(forecast.target_timestamp_utc) ?? []), forecast]);
  let count = 0;
  for (const [target, forecasts] of groups) {
    const price = await fetchCloudflareAlignedClose(Date.parse(target));
    for (const forecast of forecasts) {
      if (await appendCloudflareSettlement(env.DB, settlementFor(forecast, price))) count += 1;
    }
  }
  return count;
}

function liquidationWindow(env: Env): number {
  const value = Number(env.LIQUIDATION_WINDOW_MS ?? "3000");
  return Number.isInteger(value) && value >= 0 && value <= 30_000 ? value : 3_000;
}

interface ForecastBoundaryResult {
  requestsUsed: number;
  requestDecisions: Array<{ stage: string; allowed: boolean; reason?: string }>;
  skippedReason: string | null;
  scanOutcome: string | null;
}

function paperTradeNotional(env: Env): number {
  const value = Number(env.PAPER_TRADE_NOTIONAL_USD ?? "100");
  return Number.isFinite(value) && value >= 10 && value <= 1_000 ? value : 100;
}

async function advanceOpenPaperTrades(env: Env, nowMs: number): Promise<number> {
  const positions = await loadActivePaperTrades(env.DB);
  if (positions.length === 0) return 0;
  const earliestEntry = Math.min(...positions.map((position) => Date.parse(position.proposal.decision_timestamp_utc) + 60_000));
  const candles = await fetchCloudflarePaperCandles(earliestEntry, nowMs);
  let updated = 0;
  for (const position of positions) {
    const next = advancePaperTrade(position.proposal, candles, position.quote_notional, nowMs);
    if (next.status !== position.status || next.last_processed_candle_open_ms !== position.last_processed_candle_open_ms) {
      await saveCloudflarePaperTrade(env.DB, next);
      updated += 1;
    }
  }
  return updated;
}

async function forecastBoundary(env: Env, boundaryMs: number, requestLimit: number): Promise<ForecastBoundaryResult> {
  const boundaryUtc = new Date(boundaryMs).toISOString();
  const currentUsage = await countTypesafeRequests(env.DB, utcDay());
  const snapshotId = `BTCUSD:${boundaryUtc}:2.0.0`;
  const scanId = `scan:${snapshotId}:atr_cost_event_v1`;
  if (await hasCloudflarePaperTradeScan(env.DB, scanId)) {
    return { requestsUsed: currentUsage, requestDecisions: [], skippedReason: "scan_already_recorded", scanOutcome: null };
  }
  if (await isCollectionPaused(env.DB)) {
    return { requestsUsed: currentUsage, requestDecisions: [], skippedReason: "paused", scanOutcome: null };
  }
  const state = await buildCloudflareExperimentState(boundaryMs, liquidationWindow(env));
  const activePosition = await hasActivePaperTrade(env.DB, state.snapshot.symbol);
  let result;
  try {
    result = await decidePaperTrade(state, {
      apiKey: env.TYPESAFE_API_KEY,
      riskBlocked: activePosition ? "risk_limit" : null,
      beforeRequest: async () => {
        if (await isCollectionPaused(env.DB)) return { allowed: false, reason: "paused" };
        const nowUtc = new Date().toISOString();
        const reservation = await reserveTypesafeRequest(
          env.DB,
          boundaryUtc,
          "paper_trade_decision",
          utcDay(new Date(nowUtc)),
          nowUtc,
          requestLimit,
        );
        return { allowed: reservation.allowed, ...(reservation.allowed ? {} : { reason: reservation.reason }) };
      },
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "paper_trade_decision_failed", boundary_utc: boundaryUtc, reason: "typesafe_request_failed" }));
    const assessment = assessPaperTradeCandidate(state);
    result = {
      kind: "blocked" as const,
      assessment,
      request: { allowed: false, reason: "typesafe_error" },
    };
  }
  const scan = makePaperTradeScan(state, result);
  await appendCloudflarePaperTradeScan(env.DB, scan);
  if (scan.proposal) {
    const position = advancePaperTrade(scan.proposal, [], paperTradeNotional(env), Date.parse(scan.proposal.decision_timestamp_utc));
    await saveCloudflarePaperTrade(env.DB, position);
  }
  const requestsUsed = await countTypesafeRequests(env.DB, utcDay());
  const request = result.kind === "no_candidate" ? null : result.request;
  return {
    requestsUsed,
    requestDecisions: request ? [{ stage: "paper_trade_decision", ...request }] : [],
    skippedReason: result.kind === "blocked" ? result.request.reason ?? result.assessment.reason : result.kind === "no_candidate" ? result.assessment.reason : null,
    scanOutcome: scan.outcome,
  };
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

async function api(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method !== "GET" || !pathname.startsWith("/api/")) return null;
  if (pathname === "/api/health") return json({ ok: true, runtime: "cloudflare-workers", timestamp_utc: new Date().toISOString() });
  if (pathname === "/api/dashboard") {
    try {
      const [batches, settlements] = await Promise.all([loadCloudflareBatches(env.DB), loadCloudflareSettlements(env.DB)]);
      return json(buildDashboardData(batches, settlements));
    } catch (error) {
      console.error("dashboard", error);
      return json({ error: "Dashboard data is temporarily unavailable." }, 500);
    }
  }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const apiResponse = await api(request, env);
    if (apiResponse) return apiResponse;
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const boundaryMs = Math.floor(controller.scheduledTime / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
      const boundaryUtc = new Date(boundaryMs).toISOString();
      let requestLimit: number;
      try {
        requestLimit = parseTypesafeDailyRequestLimit(env.TYPESAFE_DAILY_REQUEST_LIMIT);
      } catch (error) {
        console.error(JSON.stringify({ event: "cost_guard_config_invalid", boundary_utc: boundaryUtc, reason: error instanceof Error ? error.message : "invalid_limit" }));
        return;
      }

      const nowUtc = new Date().toISOString();
      const claimed = await claimScheduledBoundary(env.DB, boundaryUtc, nowUtc);
      if (!claimed) {
        const requestsUsed = await countTypesafeRequests(env.DB, utcDay());
        console.log(JSON.stringify({ event: "forecast_cycle_skipped", boundary_utc: boundaryUtc, reason: "duplicate_boundary", typesafe_requests_used: requestsUsed, typesafe_daily_request_limit: requestLimit }));
        return;
      }

      try {
        if (await isCollectionPaused(env.DB)) {
          const requestsUsed = await countTypesafeRequests(env.DB, utcDay());
          await updateScheduledBoundary(env.DB, boundaryUtc, "paused", requestsUsed, requestLimit, "operator_pause", new Date().toISOString());
          console.log(JSON.stringify({ event: "forecast_cycle_skipped", boundary_utc: boundaryUtc, reason: "operator_pause", typesafe_requests_used: requestsUsed, typesafe_daily_request_limit: requestLimit }));
          return;
        }

        const settled = await settleDue(env, controller.scheduledTime);
        const paperTradesUpdated = await advanceOpenPaperTrades(env, Date.now());
        const result = await forecastBoundary(env, boundaryMs, requestLimit);
        const wasPaused = result.skippedReason === "paused" || result.requestDecisions.some((decision) => decision.reason === "paused");
        const reachedLimit = result.skippedReason === "daily_limit" || result.requestDecisions.some((decision) => decision.reason === "daily_limit");
        const status = wasPaused ? "paused" : reachedLimit ? "limit_reached" : "completed";
        await updateScheduledBoundary(env.DB, boundaryUtc, status, result.requestsUsed, requestLimit, result.skippedReason, new Date().toISOString());
        console.log(JSON.stringify({
          event: "forecast_cycle",
          boundary_utc: boundaryUtc,
          settled,
          paper_trades_updated: paperTradesUpdated,
          status,
          paper_trade_scan_outcome: result.scanOutcome,
          typesafe_requests_used: result.requestsUsed,
          typesafe_daily_request_limit: requestLimit,
          request_decisions: result.requestDecisions,
          skipped_reason: result.skippedReason,
        }));
      } catch (error) {
        const requestsUsed = await countTypesafeRequests(env.DB, utcDay()).catch(() => 0);
        await updateScheduledBoundary(env.DB, boundaryUtc, "failed", requestsUsed, requestLimit, "runtime_error", new Date().toISOString()).catch(() => undefined);
        console.error(JSON.stringify({ event: "forecast_cycle_failed", boundary_utc: boundaryUtc, typesafe_requests_used: requestsUsed, typesafe_daily_request_limit: requestLimit, error: error instanceof Error ? error.message : "unknown_error" }));
        throw error;
      }
    })());
  },
} satisfies ExportedHandler<Env>;
