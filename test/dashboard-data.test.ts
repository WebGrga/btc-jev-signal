import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardData } from "../src/dashboard-data.js";
import type {
  ExperimentState,
  Forecast,
  PredictionBatch,
  Settlement,
} from "../src/experiment-types.js";

function forecast(
  id: string,
  horizon: Forecast["horizon"],
  choice: Forecast["choice"],
  origin = "2026-09-16T08:00:00.000Z",
): Forecast {
  return {
    forecast_id: id,
    horizon,
    origin_timestamp_utc: origin,
    target_timestamp_utc: "2026-09-16T08:15:00.000Z",
    origin_price_usdt: 100,
    choice,
    confidence: 0.8,
    probabilities: { higher: 0.9, lower: 0.1 },
    model: "test",
    stage: horizon === "eod" ? "eod_cascade" : "parallel_horizons",
  };
}

test("dashboard exposes latest probabilities and settlement status without usage data", () => {
  const batch: PredictionBatch = {
    batch_id: "batch-dashboard",
    created_at_utc: "2026-09-16T08:00:01.000Z",
    experimental_only: true,
    state: {
      snapshot: {
        timestamp_utc: "2026-09-16T08:00:00.000Z",
        anchor_price_usdt: 100,
      },
    } as unknown as ExperimentState,
    forecasts: [
      forecast("f-15m", "15m", "higher"),
      forecast("f-eod", "eod", "lower", "2026-09-16T00:00:00.000Z"),
    ],
    usage: { parallel_horizons: { private: true }, eod_cascade: { private: true } },
  };
  const settlement: Settlement = {
    forecast_id: "f-15m",
    horizon: "15m",
    origin_timestamp_utc: "2026-09-16T08:00:00.000Z",
    target_timestamp_utc: "2026-09-16T08:15:00.000Z",
    settled_at_utc: "2026-09-16T08:15:05.000Z",
    origin_price_usdt: 100,
    target_price_usdt: 101,
    actual_return_pct: 1,
    predicted_direction: "higher",
    actual_direction: "higher",
    correct: true,
    predicted_probability: 0.9,
    brier_score: 0.01,
    log_loss: 0.105361,
    target_price_source: "Binance Spot completed 1m candle close",
  };

  const data = buildDashboardData([batch], [settlement], new Date("2026-09-16T09:00:00.000Z"));
  assert.equal(data.latest_batch?.batch_id, "batch-dashboard");
  assert.equal(data.latest_forecasts[0]?.status, "correct");
  assert.equal(data.latest_forecasts[1]?.status, "pending");
  assert.equal(data.probability_history[0]?.higher_probability["15m"], 0.9);
  assert.equal(data.report.reports.find((item) => item.horizon === "overall")?.issued, 2);
  assert.equal(data.schedule["1h"].expected_per_utc_day, 24);
  assert.equal("usage" in data.latest_forecasts[0]!, false);
  assert.equal("usage" in data.latest_batch!, false);
});
