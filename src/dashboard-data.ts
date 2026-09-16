import { buildReport } from "./experiment-report.js";
import type {
  ExperimentReport,
  Forecast,
  Horizon,
  PredictionBatch,
  Settlement,
} from "./experiment-types.js";

export type ForecastStatus = "pending" | "correct" | "incorrect" | "tie";

export interface DashboardForecast {
  forecast_id: string;
  horizon: Horizon;
  origin_timestamp_utc: string;
  target_timestamp_utc: string;
  origin_price_usdt: number;
  choice: Forecast["choice"];
  confidence: number;
  probabilities: Forecast["probabilities"];
  stage: Forecast["stage"];
  status: ForecastStatus;
  target_price_usdt: number | null;
  actual_direction: Settlement["actual_direction"] | null;
  actual_return_pct: number | null;
  brier_score: number | null;
  log_loss: number | null;
}

export interface ProbabilityPoint {
  timestamp_utc: string;
  anchor_price_usdt: number;
  higher_probability: Record<Horizon, number>;
}

export interface DashboardBatch {
  batch_id: string;
  created_at_utc: string;
  experimental_only: true;
  state: PredictionBatch["state"];
}

export interface DashboardData {
  generated_at_utc: string;
  experimental_only: true;
  disclaimer: string;
  latest_batch: DashboardBatch | null;
  latest_forecasts: DashboardForecast[];
  recent_forecasts: DashboardForecast[];
  probability_history: ProbabilityPoint[];
  report: ExperimentReport;
}

function settlementStatus(settlement: Settlement | undefined): ForecastStatus {
  if (!settlement) return "pending";
  if (settlement.correct === null) return "tie";
  return settlement.correct ? "correct" : "incorrect";
}

function dashboardForecast(
  forecast: Forecast,
  settlementsById: ReadonlyMap<string, Settlement>,
): DashboardForecast {
  const settlement = settlementsById.get(forecast.forecast_id);
  return {
    forecast_id: forecast.forecast_id,
    horizon: forecast.horizon,
    origin_timestamp_utc: forecast.origin_timestamp_utc,
    target_timestamp_utc: forecast.target_timestamp_utc,
    origin_price_usdt: forecast.origin_price_usdt,
    choice: forecast.choice,
    confidence: forecast.confidence,
    probabilities: forecast.probabilities,
    stage: forecast.stage,
    status: settlementStatus(settlement),
    target_price_usdt: settlement?.target_price_usdt ?? null,
    actual_direction: settlement?.actual_direction ?? null,
    actual_return_pct: settlement?.actual_return_pct ?? null,
    brier_score: settlement?.brier_score ?? null,
    log_loss: settlement?.log_loss ?? null,
  };
}

export function buildDashboardData(
  batches: readonly PredictionBatch[],
  settlements: readonly Settlement[],
  generatedAt = new Date(),
): DashboardData {
  const sortedBatches = [...batches].sort(
    (left, right) =>
      Date.parse(left.state.snapshot.timestamp_utc) - Date.parse(right.state.snapshot.timestamp_utc),
  );
  const settlementsById = new Map(
    settlements.map((settlement) => [settlement.forecast_id, settlement] as const),
  );
  const latestBatch = sortedBatches.at(-1) ?? null;
  const recentBatches = sortedBatches.slice(-192);
  const recentForecasts = recentBatches
    .flatMap((batch) => batch.forecasts.map((forecast) => dashboardForecast(forecast, settlementsById)))
    .sort(
      (left, right) =>
        Date.parse(right.origin_timestamp_utc) - Date.parse(left.origin_timestamp_utc),
    );

  return {
    generated_at_utc: generatedAt.toISOString(),
    experimental_only: true,
    disclaimer:
      "Experimental personal project using TypeSafe Jev. It is not financial advice and does not place trades.",
    latest_batch: latestBatch
      ? {
          batch_id: latestBatch.batch_id,
          created_at_utc: latestBatch.created_at_utc,
          experimental_only: true,
          state: latestBatch.state,
        }
      : null,
    latest_forecasts:
      latestBatch?.forecasts.map((forecast) => dashboardForecast(forecast, settlementsById)) ?? [],
    recent_forecasts: recentForecasts,
    probability_history: recentBatches.map((batch) => ({
      timestamp_utc: batch.state.snapshot.timestamp_utc,
      anchor_price_usdt: batch.state.snapshot.anchor_price_usdt,
      higher_probability: Object.fromEntries(
        batch.forecasts.map((forecast) => [forecast.horizon, forecast.probabilities.higher]),
      ) as Record<Horizon, number>,
    })),
    report: buildReport(sortedBatches, settlements),
  };
}
