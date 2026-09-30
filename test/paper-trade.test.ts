import assert from "node:assert/strict";
import test from "node:test";
import {
  assessPaperTradeCandidate,
  buildPaperTradeProposal,
  decidePaperTrade,
  makePaperTradeScan,
  type CandidateAssessment,
} from "../src/paper-trade.js";
import type { ExperimentState } from "../src/experiment-types.js";
import type { Candle } from "../src/types.js";
import { advancePaperTrade } from "../src/paper-simulator.js";

const now = Date.parse("2026-09-29T12:15:10.000Z");
const state = {
  schema_version: "2.0.0",
  snapshot: {
    timestamp_utc: "2026-09-29T12:15:00.000Z",
    collected_at_utc: "2026-09-29T12:15:05.000Z",
    collection_lag_ms: 5_000,
    cadence: "scheduled_15m",
    symbol: "BTCUSD",
    quote_asset: "USD",
    anchor_price_usdt: 65_000,
    anchor_price_source: "test fixture",
  },
  timeframes: {
    "15m": { calculated_through_utc: "2026-09-29T12:14:59.999Z" },
    "1h": { atr_14_pct: 0.7 },
    "4h": { atr_14_pct: 0.9, atr_14_usdt: 100 },
  },
  order_book: { available: true, spread_bps: 2, as_of_utc: "2026-09-29T12:15:08.000Z" },
} as unknown as ExperimentState;

const assessment: CandidateAssessment = {
  candidate: true,
  reason: null,
  dataFreshnessMs: 10_000,
  estimatedMoveBps: 300,
  costs: {
    model_version: "conservative_spot_costs_v1",
    taker_fee_bps_per_side: 80,
    spread_bps_round_trip: 2,
    slippage_bps_per_side: 5,
    estimated_round_trip_bps: 172,
  },
};

test("candidate scanner fails closed on missing and stale data, and skips low-move events", () => {
  const fresh = assessPaperTradeCandidate(state, now);
  assert.equal(fresh.candidate, true);
  assert.equal(fresh.estimatedMoveBps, 180);

  const stale = structuredClone(state);
  stale.snapshot.timestamp_utc = "2026-09-29T11:00:00.000Z";
  assert.equal(assessPaperTradeCandidate(stale, now).reason, "stale_data");

  const unavailable = structuredClone(state);
  unavailable.order_book.available = false;
  assert.equal(assessPaperTradeCandidate(unavailable, now).reason, "missing_order_book");

  const lowMove = structuredClone(state);
  lowMove.timeframes["4h"].atr_14_pct = 0.2;
  assert.equal(assessPaperTradeCandidate(lowMove, now).reason, "move_below_estimated_cost");
});

test("stale candidate scans are persisted as blocked without making a TypeSafe call", async () => {
  const stale = structuredClone(state);
  stale.snapshot.timestamp_utc = "2026-09-29T11:00:00.000Z";
  const result = await decidePaperTrade(stale, { now: () => new Date(now), beforeRequest: async () => { throw new Error("must not request"); } });
  assert.equal(result.kind, "blocked");
  assert.equal(result.assessment.reason, "stale_data");
  const scan = makePaperTradeScan(stale, result, new Date(now));
  assert.equal(scan.outcome, "blocked");
  assert.equal(scan.proposal, null);
  assert.equal(scan.scan_id, makePaperTradeScan(stale, result, new Date(now)).scan_id);
});

test("malformed model answers become an auditable no-trade proposal", () => {
  const proposal = buildPaperTradeProposal(state, assessment, { answers: {} }, new Date(now));
  assert.equal(proposal.action, "no_trade");
  assert.equal(proposal.reason_code, "malformed_model_output");
  assert.equal(proposal.eligible, false);
  assert.equal(proposal.selected_policy_id, null);
});

test("policy selection joins the matching Noul and keeps Choice confidence separate", () => {
  const proposal = buildPaperTradeProposal(state, assessment, {
    model: "jev-test",
    answers: {
      action: {
        choice: "enter_long:atr_1x_2x_240m",
        confidence: 0.63,
        probabilities: { no_trade: 0.2, "enter_long:atr_1x_1_5x_240m": 0.25, "enter_long:atr_1x_2x_240m": 0.55 },
      },
      net_positive_atr_1x_1_5x_240m: { noul: 0.42 },
      net_positive_atr_1x_2x_240m: { noul: 0.71 },
    },
  }, new Date(now));
  assert.equal(proposal.action, "enter_long:atr_1x_2x_240m");
  assert.equal(proposal.selected_policy_id, "atr_1x_2x_240m");
  assert.equal(proposal.selected_net_positive_probability, 0.71);
  assert.equal(proposal.typesafe_confidence, 0.63);
  assert.equal(proposal.eligible, true);
  assert.equal(proposal.paper_trade_id, null);
});

function validProposal() {
  return buildPaperTradeProposal(state, assessment, {
    model: "jev-test",
    answers: {
      action: {
        choice: "enter_long:atr_1x_1_5x_240m",
        confidence: 0.8,
        probabilities: { no_trade: 0.1, "enter_long:atr_1x_1_5x_240m": 0.8, "enter_long:atr_1x_2x_240m": 0.1 },
      },
      net_positive_atr_1x_1_5x_240m: { noul: 0.7 },
      net_positive_atr_1x_2x_240m: { noul: 0.6 },
    },
  }, new Date(now));
}

function candle(openTimeMs: number, open: number, high: number, low: number, close = open): Candle {
  return {
    openTimeMs,
    closeTimeMs: openTimeMs + 59_999,
    open,
    high: Math.max(open, high, close),
    low: Math.min(open, low, close),
    close,
    baseVolume: 1,
    quoteVolume: open,
    trades: 1,
    takerBuyBaseVolume: 0,
    takerBuyQuoteVolume: 0,
  };
}

test("paper execution enters on the next eligible candle and applies fee, spread, and slippage costs", () => {
  const proposal = validProposal();
  const decisionMs = Date.parse(proposal.decision_timestamp_utc);
  const position = advancePaperTrade(proposal, [
    candle(decisionMs + 60_000, 65_000, 65_050, 64_990, 65_020),
    candle(decisionMs + 120_000, 65_100, 65_300, 65_050, 65_250),
  ], 100, decisionMs + 180_000);
  assert.equal(position.status, "closed");
  assert.equal(position.exit_reason, "target");
  assert.equal(position.entry?.candle_open_time_utc, new Date(decisionMs + 60_000).toISOString());
  assert.equal(position.source_candles.length, 2);
  assert.equal(position.source_candles[1]?.high, 65_300);
  assert.ok(position.fees_quote! > 0);
  assert.ok(position.spread_cost_quote! > 0);
  assert.ok(position.slippage_cost_quote! > 0);
  assert.equal(position.net_pnl_quote, position.gross_pnl_quote! - position.fees_quote! - position.spread_cost_quote! - position.slippage_cost_quote!);
  assert.equal(position.trade_id, `paper:${proposal.proposal_id}`);
});

test("paper execution resolves ambiguous stop/target bars stop-first and handles adverse gaps", () => {
  const proposal = validProposal();
  const decisionMs = Date.parse(proposal.decision_timestamp_utc);
  const entry = candle(decisionMs + 60_000, 65_000, 65_050, 64_950, 65_000);
  const both = advancePaperTrade(proposal, [entry, candle(decisionMs + 120_000, 65_000, 65_300, 64_800, 65_000)], 100, decisionMs + 180_000);
  assert.equal(both.status, "closed");
  assert.equal(both.exit_reason, "stop");
  assert.ok(both.exit!.raw_price <= both.stop_price!);

  const gap = advancePaperTrade(proposal, [entry, candle(decisionMs + 120_000, 64_700, 64_800, 64_600, 64_700)], 100, decisionMs + 180_000);
  assert.equal(gap.exit_reason, "stop_gap");
  assert.equal(gap.exit!.raw_price, 64_700);
});

test("missing entry and missing intervening candles stay pending or fail closed as unpriceable", () => {
  const proposal = validProposal();
  const decisionMs = Date.parse(proposal.decision_timestamp_utc);
  assert.equal(advancePaperTrade(proposal, [], 100, decisionMs + 30_000).status, "pending_entry");
  assert.equal(advancePaperTrade(proposal, [], 100, decisionMs + 120_000).status, "unpriceable");
  const entry = candle(decisionMs + 60_000, 65_000, 65_050, 64_950);
  const gap = candle(decisionMs + 180_000, 65_000, 65_050, 64_950);
  assert.equal(advancePaperTrade(proposal, [entry, gap], 100, decisionMs + 300_000).status, "unpriceable");
});

test("paper positions stay open without a complete exit and exit at the maximum-hold candle open", () => {
  const proposal = validProposal();
  const decisionMs = Date.parse(proposal.decision_timestamp_utc);
  const entryMs = decisionMs + 60_000;
  const short = advancePaperTrade(proposal, [candle(entryMs, 65_000, 65_050, 64_950)], 100, decisionMs + 120_000);
  assert.equal(short.status, "open");
  assert.equal(short.net_pnl_quote, null);

  const candles = Array.from({ length: 241 }, (_, index) => candle(entryMs + index * 60_000, 65_000, 65_050, 64_950));
  const closed = advancePaperTrade(proposal, candles, 100, entryMs + 241 * 60_000);
  assert.equal(closed.status, "closed");
  assert.equal(closed.exit_reason, "time_limit");
  assert.equal(closed.exit?.raw_price, 65_000);
});

test("replaying the same proposal and candles produces an identical paper position", () => {
  const proposal = validProposal();
  const decisionMs = Date.parse(proposal.decision_timestamp_utc);
  const candles = [
    candle(decisionMs + 60_000, 65_000, 65_050, 64_990, 65_020),
    candle(decisionMs + 120_000, 65_100, 65_300, 65_050, 65_250),
  ];
  const first = advancePaperTrade(proposal, candles, 100, decisionMs + 180_000);
  const retry = advancePaperTrade(proposal, candles, 100, decisionMs + 180_000);
  assert.deepEqual(retry, first);
});
