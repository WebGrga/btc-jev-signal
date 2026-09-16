import { buildExperimentState, fetchAlignedClose } from "./experiment-market.js";
import { predictExperiment } from "./experiment-jev.js";
import { buildReport, reportMarkdown } from "./experiment-report.js";
import {
  appendBatch,
  appendSettlement,
  experimentPaths,
  loadBatches,
  loadSettlements,
  saveReport,
} from "./experiment-store.js";
import { safeErrorMessage } from "./http.js";
import type {
  ActualDirection,
  ExperimentState,
  Forecast,
  PredictionBatch,
  Settlement,
} from "./experiment-types.js";
import { horizonsDueAt } from "./experiment-schedule.js";

const MINUTE_MS = 60_000;
const FIFTEEN_MINUTES_MS = 15 * MINUTE_MS;
const SETTLEMENT_GRACE_MS = 5_000;
const CYCLE_RETRY_WINDOW_MS = 3 * MINUTE_MS;
const CYCLE_RETRY_DELAY_MS = 10_000;

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function batchId(timestampIso: string): string {
  return `batch_${timestampIso.replace(/[-:.]/g, "")}`;
}

function actualDirection(origin: number, target: number): ActualDirection {
  if (target > origin) return "higher";
  if (target < origin) return "lower";
  return "unchanged";
}

function settlementFor(forecast: Forecast, targetPrice: number): Settlement {
  const actual = actualDirection(forecast.origin_price_usdt, targetPrice);
  const actualIsScorable = actual !== "unchanged";
  const probability = actualIsScorable ? forecast.probabilities[actual] : null;
  const higherOutcome = actual === "higher" ? 1 : 0;
  const pHigher = forecast.probabilities.higher;
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
    correct: actualIsScorable ? forecast.choice === actual : null,
    predicted_probability: probability,
    brier_score: actualIsScorable ? round((pHigher - higherOutcome) ** 2) : null,
    log_loss: probability === null ? null : round(-Math.log(Math.max(1e-12, probability))),
    target_price_source: "Binance Spot completed 1m candle close",
  };
}

export async function writeCurrentReport(): Promise<void> {
  const paths = experimentPaths();
  const [batches, settlements] = await Promise.all([loadBatches(paths), loadSettlements(paths)]);
  const report = buildReport(batches, settlements);
  await saveReport(report, reportMarkdown(report), paths);
}

export async function settleDueForecasts(nowMs = Date.now()): Promise<number> {
  const paths = experimentPaths();
  const [batches, settlements] = await Promise.all([loadBatches(paths), loadSettlements(paths)]);
  const settledIds = new Set(settlements.map((settlement) => settlement.forecast_id));
  const due = batches
    .flatMap((batch) => batch.forecasts)
    .filter(
      (forecast) =>
        !settledIds.has(forecast.forecast_id) &&
        Date.parse(forecast.target_timestamp_utc) + SETTLEMENT_GRACE_MS <= nowMs,
    );
  const byTarget = new Map<string, Forecast[]>();
  for (const forecast of due) {
    const values = byTarget.get(forecast.target_timestamp_utc) ?? [];
    values.push(forecast);
    byTarget.set(forecast.target_timestamp_utc, values);
  }

  let count = 0;
  for (const [targetIso, forecasts] of byTarget) {
    try {
      const targetPrice = await fetchAlignedClose(Date.parse(targetIso));
      for (const forecast of forecasts) {
        await appendSettlement(settlementFor(forecast, targetPrice), paths);
        count += 1;
      }
    } catch (error) {
      process.stderr.write(`Could not settle forecasts for ${targetIso}: ${safeErrorMessage(error)}\n`);
    }
  }
  await writeCurrentReport();
  return count;
}

function cycleSummary(batch: PredictionBatch): string {
  const lines = [
    `Forecast batch ${batch.batch_id}`,
    `  Origin: ${batch.state.snapshot.timestamp_utc} at ${batch.state.snapshot.anchor_price_usdt.toFixed(2)} USDT`,
  ];
  for (const forecast of batch.forecasts) {
    lines.push(
      `  ${forecast.horizon.padEnd(3)} → ${forecast.choice} | higher ${(forecast.probabilities.higher * 100).toFixed(1)}% | lower ${(forecast.probabilities.lower * 100).toFixed(1)}% | target ${forecast.target_timestamp_utc}`,
    );
  }
  lines.push(`  Data: ${experimentPaths().directory}`);
  return lines.join("\n");
}

export async function runForecastCycle(
  boundaryMs: number,
  cadence: ExperimentState["snapshot"]["cadence"],
  liquidationWindowMs: number,
): Promise<PredictionBatch | null> {
  const paths = experimentPaths();
  const originIso = new Date(boundaryMs).toISOString();
  const id = batchId(originIso);
  const existing = await loadBatches(paths);
  if (existing.some((batch) => batch.batch_id === id)) {
    process.stderr.write(`Skipping existing forecast batch ${id}\n`);
    return null;
  }
  const state = await buildExperimentState(boundaryMs, cadence, liquidationWindowMs);
  const prediction = cadence === "scheduled_15m"
    ? await predictExperiment(state, horizonsDueAt(boundaryMs))
    : await predictExperiment(state);
  const batch: PredictionBatch = {
    batch_id: id,
    created_at_utc: new Date().toISOString(),
    experimental_only: true,
    state,
    forecasts: prediction.forecasts,
    usage: prediction.usage,
  };
  await appendBatch(batch, paths);
  await writeCurrentReport();
  process.stderr.write(`${cycleSummary(batch)}\n`);
  return batch;
}

function scheduledBoundary(nowMs: number, delayMs: number): number {
  const current = Math.floor(nowMs / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
  return nowMs <= current + delayMs ? current : current + FIFTEEN_MINUTES_MS;
}

async function waitUntil(targetMs: number, shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    const remaining = targetMs - Date.now();
    if (remaining <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 30_000)));
  }
}

export async function runContinuousExperiment(
  liquidationWindowMs: number,
  boundaryDelayMs: number,
): Promise<void> {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const initiallySettled = await settleDueForecasts();
  if (initiallySettled > 0) process.stderr.write(`Settled ${initiallySettled} overdue forecast(s).\n`);

  while (!stopping) {
    const boundaryMs = scheduledBoundary(Date.now(), boundaryDelayMs);
    const runAtMs = boundaryMs + boundaryDelayMs;
    process.stderr.write(`Next scheduled forecast: ${new Date(runAtMs).toISOString()}\n`);
    await waitUntil(runAtMs, () => stopping);
    if (stopping) break;
    const retryDeadline = boundaryMs + CYCLE_RETRY_WINDOW_MS;
    let completed = false;
    while (!stopping && !completed) {
      try {
        const settled = await settleDueForecasts();
        if (settled > 0) process.stderr.write(`Settled ${settled} forecast(s).\n`);
        await runForecastCycle(boundaryMs, "scheduled_15m", liquidationWindowMs);
        completed = true;
      } catch (error) {
        process.stderr.write(`Forecast cycle attempt failed: ${safeErrorMessage(error)}\n`);
        if (Date.now() + CYCLE_RETRY_DELAY_MS > retryDeadline) {
          process.stderr.write(`Giving up boundary ${new Date(boundaryMs).toISOString()} after the bounded retry window.\n`);
          break;
        }
        process.stderr.write(`Retrying the same boundary in ${CYCLE_RETRY_DELAY_MS / 1000} seconds.\n`);
        await waitUntil(Date.now() + CYCLE_RETRY_DELAY_MS, () => stopping);
      }
    }
  }

  await settleDueForecasts();
  await writeCurrentReport();
  process.stderr.write("Experiment stopped cleanly. Current report was saved.\n");
}

export async function runOneExperimentCycle(liquidationWindowMs: number): Promise<void> {
  await settleDueForecasts();
  const boundaryMs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  await runForecastCycle(boundaryMs, "manual_once", liquidationWindowMs);
}
