import assert from "node:assert/strict";
import test from "node:test";
import { horizonsDueAt, isPrimaryForecast } from "../src/experiment-schedule.js";
import type { Forecast } from "../src/experiment-types.js";

function at(value: string): number {
  return Date.parse(value);
}

test("natural schedule issues only horizons due at each UTC boundary", () => {
  assert.deepEqual(horizonsDueAt(at("2026-09-16T07:15:00.000Z")), ["15m"]);
  assert.deepEqual(horizonsDueAt(at("2026-09-16T07:17:00.000Z")), []);
  assert.deepEqual(horizonsDueAt(at("2026-09-16T07:00:00.000Z")), ["15m", "1h"]);
  assert.deepEqual(horizonsDueAt(at("2026-09-16T08:00:00.000Z")), ["15m", "1h", "4h"]);
  assert.deepEqual(horizonsDueAt(at("2026-09-17T00:00:00.000Z")), ["15m", "1h", "4h", "eod"]);
});

test("legacy overlapping forecasts are excluded from primary scoring", () => {
  const base: Forecast = {
    forecast_id: "test",
    horizon: "1h",
    origin_timestamp_utc: "2026-09-16T07:15:00.000Z",
    target_timestamp_utc: "2026-09-16T08:15:00.000Z",
    origin_price_usdt: 100,
    choice: "higher",
    confidence: 0.8,
    probabilities: { higher: 0.8, lower: 0.2 },
    model: "test",
    stage: "parallel_horizons",
  };
  assert.equal(isPrimaryForecast(base), false);
  assert.equal(isPrimaryForecast({ ...base, origin_timestamp_utc: "2026-09-16T08:00:00.000Z" }), true);
});
