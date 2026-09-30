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
    "4h": { atr_14_pct: 0.9 },
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
