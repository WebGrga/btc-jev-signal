import assert from "node:assert/strict";
import test from "node:test";
import { buildReport } from "../src/experiment-report.js";
import type {
  ExperimentState,
  Forecast,
  PredictionBatch,
  Settlement,
} from "../src/experiment-types.js";

function forecast(id: string, horizon: Forecast["horizon"]): Forecast {
  return {
    forecast_id: id,
    horizon,
    origin_timestamp_utc: "2026-09-16T00:00:00.000Z",
    target_timestamp_utc: "2026-09-16T00:15:00.000Z",
    origin_price_usdt: 100,
    choice: "higher",
    confidence: 0.4,
    probabilities: { higher: 0.7, lower: 0.3 },
    model: "test",
    stage: "parallel_horizons",
  };
}

test("report separates settled, pending, and proper scores", () => {
  const batch: PredictionBatch = {
    batch_id: "batch-test",
    created_at_utc: "2026-09-16T00:00:01.000Z",
    experimental_only: true,
    state: {
      snapshot: { timestamp_utc: "2026-09-16T00:00:00.000Z" },
    } as unknown as ExperimentState,
    forecasts: [forecast("f-15m", "15m"), forecast("f-1h", "1h")],
    usage: { parallel_horizons: {}, eod_cascade: {} },
  };
  const settlement: Settlement = {
    forecast_id: "f-15m",
    horizon: "15m",
    origin_timestamp_utc: "2026-09-16T00:00:00.000Z",
    target_timestamp_utc: "2026-09-16T00:15:00.000Z",
    settled_at_utc: "2026-09-16T00:15:05.000Z",
    origin_price_usdt: 100,
    target_price_usdt: 101,
    actual_return_pct: 1,
    predicted_direction: "higher",
    actual_direction: "higher",
    correct: true,
    predicted_probability: 0.7,
    brier_score: 0.09,
    log_loss: 0.356675,
    target_price_source: "Binance Spot completed 1m candle close",
  };

  const report = buildReport([batch], [settlement]);
  const fifteenMinute = report.reports.find((item) => item.horizon === "15m")!;
  const oneHour = report.reports.find((item) => item.horizon === "1h")!;
  const overall = report.reports.find((item) => item.horizon === "overall")!;
  assert.equal(fifteenMinute.accuracy, 1);
  assert.equal(fifteenMinute.mean_brier_score, 0.09);
  assert.equal(oneHour.pending, 1);
  assert.equal(overall.issued, 2);
  assert.equal(overall.settled, 1);
});
