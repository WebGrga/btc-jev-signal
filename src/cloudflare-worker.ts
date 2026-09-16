/// <reference types="@cloudflare/workers-types" />

import { buildDashboardData } from "./dashboard-data.js";
import { buildCloudflareExperimentState, fetchCloudflareAlignedClose } from "./cloudflare-market.js";
import { predictExperiment } from "./experiment-jev.js";
import { horizonsDueAt } from "./experiment-schedule.js";
import {
  appendCloudflareBatch,
  appendCloudflareSettlement,
  loadCloudflareBatches,
  loadCloudflareSettlements,
} from "./cloudflare-store.js";
import type {
  ActualDirection,
  Forecast,
  PredictionBatch,
  Settlement,
} from "./experiment-types.js";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TYPESAFE_API_KEY: string;
  LIQUIDATION_WINDOW_MS?: string;
}

const FIFTEEN_MINUTES_MS = 15 * 60_000;
const SETTLEMENT_GRACE_MS = 5_000;

function round(value: number, digits = 6): number { return Number(value.toFixed(digits)); }
function batchId(timestampIso: string): string { return `batch_${timestampIso.replace(/[-:.]/g, "")}`; }
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

async function forecastBoundary(env: Env, boundaryMs: number): Promise<void> {
  const batches = await loadCloudflareBatches(env.DB);
  const id = batchId(new Date(boundaryMs).toISOString());
  if (batches.some((batch) => batch.batch_id === id)) return;
  const state = await buildCloudflareExperimentState(boundaryMs, liquidationWindow(env));
  const prediction = await predictExperiment(state, horizonsDueAt(boundaryMs), env.TYPESAFE_API_KEY);
  const batch: PredictionBatch = {
    batch_id: id,
    created_at_utc: new Date().toISOString(),
    experimental_only: true,
    state,
    forecasts: prediction.forecasts,
    usage: prediction.usage,
  };
  await appendCloudflareBatch(env.DB, batch);
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
      const settled = await settleDue(env, controller.scheduledTime);
      await forecastBoundary(env, boundaryMs);
      console.log(JSON.stringify({ event: "forecast_cycle", boundary_utc: new Date(boundaryMs).toISOString(), settled }));
    })());
  },
} satisfies ExportedHandler<Env>;
