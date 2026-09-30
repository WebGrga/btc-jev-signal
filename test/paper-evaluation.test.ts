import assert from "node:assert/strict";
import test from "node:test";
import { buildPaperEvaluation } from "../src/paper-evaluation.js";
import { advancePaperTrade } from "../src/paper-simulator.js";
import { buildPaperTradeProposal, type PaperTradeScan } from "../src/paper-trade.js";
import type { ExperimentState } from "../src/experiment-types.js";
import type { Candle } from "../src/types.js";

const market = {
  schema_version: "2.0.0",
  snapshot: {
    timestamp_utc: "2026-01-01T12:15:00.000Z",
    collected_at_utc: "2026-01-01T12:15:05.000Z",
    collection_lag_ms: 5_000,
    cadence: "scheduled_15m",
    symbol: "BTCUSD",
    quote_asset: "USD",
    anchor_price_usdt: 65_000,
    anchor_price_source: "test fixture",
  },
  returns_pct: { "4h": 0.5 },
  timeframes: {
    "15m": { calculated_through_utc: "2026-01-01T12:14:59.999Z" },
    "1h": { atr_14_pct: 0.7 },
    "4h": { atr_14_pct: 0.9, atr_14_usdt: 100 },
  },
  order_book: { available: true, spread_bps: 2, as_of_utc: "2026-01-01T12:15:08.000Z" },
} as unknown as ExperimentState;

const assessment = {
  candidate: true,
  reason: null,
  dataFreshnessMs: 10_000,
  estimatedMoveBps: 300,
  costs: {
    model_version: "conservative_spot_costs_v1" as const,
    taker_fee_bps_per_side: 80,
    spread_bps_round_trip: 2,
    slippage_bps_per_side: 5,
    estimated_round_trip_bps: 172,
  },
};

function candle(openTimeMs: number, open: number, high: number, low: number): Candle {
  return { openTimeMs, closeTimeMs: openTimeMs + 59_999, open, high, low, close: open, baseVolume: 1, quoteVolume: open, trades: 1, takerBuyBaseVolume: 0, takerBuyQuoteVolume: 0 };
}

function record(day: number, month: number): { scan: PaperTradeScan; position: ReturnType<typeof advancePaperTrade> } {
  const timestamp = new Date(Date.UTC(2026, month - 1, day, 12, 15)).toISOString();
  const proposal = buildPaperTradeProposal(market, assessment, {
    model: "test",
    answers: {
      action: { choice: "enter_long:atr_1x_1_5x_240m", confidence: 0.7, probabilities: { no_trade: 0.1, "enter_long:atr_1x_1_5x_240m": 0.8, "enter_long:atr_1x_2x_240m": 0.1 } },
      net_positive_atr_1x_1_5x_240m: { noul: 0.7 },
      net_positive_atr_1x_2x_240m: { noul: 0.6 },
    },
  });
  proposal.decision_timestamp_utc = timestamp;
  proposal.proposal_id = `proposal:${timestamp}`;
  proposal.candidate_event_id = `candidate:${timestamp}`;
  const decisionMs = Date.parse(timestamp);
  const position = advancePaperTrade(proposal, [
    candle(decisionMs + 60_000, 65_000, 65_050, 64_990),
    candle(decisionMs + 120_000, 65_100, 65_300, 65_050),
  ], 100, decisionMs + 180_000);
  const scan = {
    proposal,
    market_state: market,
  } as PaperTradeScan;
  return { scan, position };
}

test("walk-forward folds use only earlier months and adding later results leaves prior folds unchanged", () => {
  const training = Array.from({ length: 20 }, (_, index) => record(index + 1, 1));
  const firstTest = record(1, 2);
  const throughFebruary = buildPaperEvaluation(
    [...training, firstTest].map((item) => item.scan),
    [...training, firstTest].map((item) => item.position),
    [],
    new Date("2026-03-01T00:00:00.000Z"),
  );
  assert.equal(throughFebruary.folds[0]?.status, "warmup");
  assert.equal(throughFebruary.folds[1]?.status, "out_of_sample");
  assert.equal(throughFebruary.folds[1]?.training_trades_available, 20);

  const later = record(1, 3);
  const withMarch = buildPaperEvaluation(
    [...training, firstTest, later].map((item) => item.scan),
    [...training, firstTest, later].map((item) => item.position),
    [],
    new Date("2026-04-01T00:00:00.000Z"),
  );
  assert.deepEqual(withMarch.folds[1], throughFebruary.folds[1]);
  assert.equal(throughFebruary.out_of_sample_strategies.find((item) => item.strategy === "direction_only_forecast")?.evidence_status, "unavailable");
});

