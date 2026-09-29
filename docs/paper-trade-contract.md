# Jev paper-trade contract and evaluation design

**Status:** implemented in the Cloudflare Worker as a paper-only decision record. Paper execution and dashboard display are follow-up work.

## Purpose

The current experiment records whether Jev's higher/lower price direction was
correct at a fixed target time. That is a forecast score, not evidence that a
trade could have been entered, managed, and exited profitably. The paper-trade
workflow must preserve that distinction.

The new workflow will answer four separate questions:

1. Did the market-data scanner find a candidate event worth asking Jev about?
2. Did Jev recommend a trade or no trade, and which bounded policy did it select?
3. Would the proposal have been eligible under deterministic data, cost, and risk
   checks?
4. What would a reproducible paper execution have returned after costs?

Forecasts, model judgments, code eligibility decisions, simulated positions, and
evaluation results are separate records linked by immutable IDs. No record is
rewritten after its outcome becomes known.

## Current-system observations

- `ExperimentState` captures market context and target timestamps.
- `Forecast` records a higher/lower judgment and probability distribution.
- `Settlement` scores the direction at its target timestamp with accuracy, Brier,
  and log-loss metrics.
- The local runner stores prediction and settlement JSONL files; Cloudflare uses
  D1. The dashboard currently presents forecasts and their directional scores.
- Jev is called on a schedule today. A paper-trade decision should instead be
  requested only for a deterministic candidate event. Market data may still be
  sampled on a fixed cadence; the scanner records when it declines to call Jev
  and why.

## Model decision and probability semantics

For each candidate event, the TypeSafe request should ask a small set of
independent, typed questions over the same named state:

- A `Choice` for `enter_long` versus `no_trade` (and, once a paper position is
  supported, a separate position-management decision).
- A choice from a finite, versioned set of paper exit policies. Jev does not
  invent arbitrary prices, sizes, or executable orders.
- A `Noul` for each fixed candidate policy, asking whether that exact policy
  produces positive net P&L after the cost assumptions supplied in the state.
  The Choice and Nouls are independent, so the policy library and its cost
  assumptions must already be in the shared state; code joins Jev's selected
  policy to that policy's Noul answer. This probability is stored separately
  from the action distribution and must be calibrated against later paper
  outcomes before code relies on a threshold.
- A bounded reason code and risk flag set for audit. Free-form explanation is
  optional display text and never controls execution or scoring.

The `Choice` distribution expresses preference among its listed alternatives;
its confidence is not the probability that a trade will be profitable. The
`Noul` probability is about net profitability only because its question names
that exact event and policy. It is still a model judgment until validated on
out-of-sample results. Code remains responsible for hard limits and final
eligibility.

Independent questions should share one TypeSafe request per candidate event
where possible. This keeps request count bounded, but question count and token
usage still need to be observed. Keep the initial policy library small. The
existing Cloudflare request cap continues to apply.

The first implementation asks one `Choice` across `no_trade` and two fixed
long-only policies, plus one `Noul` for each policy, in the same request. The
v1 policies use a 1 ATR stop, targets at 1.5 or 2 ATR, and a four-hour maximum
holding time. The deterministic scanner compares twice the completed 4h ATR
with its estimated round-trip costs. It calls Jev only when this potential move
exceeds the cost estimate and all required spot data is fresh. This threshold
is a versioned starting rule, not a learned or validated trading edge.

The initial cost estimate assumes 80 bps taker fee per side, the observed
order-book spread for a round trip, and 5 bps slippage per side. The fee uses
Kraken's current lowest-volume spot taker tier as a conservative reference;
actual account and venue fees can differ. The assumed costs are recorded with
each scan and must be reviewed/versioned before simulator results are treated
as venue-specific. See [Kraken's fee schedule](https://www.kraken.com/features/fee-schedule).

This follows TypeSafe's documented distinction between [Choice](https://docs.typesafe.ai/primitives/choice),
[Noul](https://docs.typesafe.ai/primitives/noul), shared [State](https://docs.typesafe.ai/concepts/state),
and [confidence](https://docs.typesafe.ai/confidence).

## Proposed proposal record

The first schema is versioned (`paper_trade_proposal_v1`) and contains at least:

| Field group | Required contents |
| --- | --- |
| Identity | proposal ID, candidate-event ID, schema version, policy version, created time |
| Provenance | exact snapshot/batch ID, source forecast IDs, symbol, quote asset, source names |
| Candidate | direction, decision window, entry rule, selected bounded exit-policy ID |
| Jev judgment | action, action probability distribution, TypeSafe confidence, net-positive Noul probability, bounded reason/risk codes, model ID |
| Code checks | data freshness/availability, cost-model version, estimated costs, eligibility state and reason code |
| Outcome link | paper-trade ID and eventual settlement/evaluation IDs, initially null |

The candidate plan is defined before the outcome is observed. The initial policy
library should stay small and be fixed before the final holdout is evaluated.
Stops, targets, and maximum holding time use named policy parameters, such as
ATR-based distance and a finite reward/risk set, rather than model-generated
arbitrary price values. A proposal that fails a code check becomes `no_trade`
with a stable reason code; the original Jev answer remains recorded.

## Candidate events and no-trade path

The scanner may collect market snapshots at a stable cadence, but it calls Jev
only when a versioned deterministic prefilter emits a candidate event. The first
prefilter is intentionally simple and testable. It uses only information
available at decision time, including data freshness and an estimated round-trip
cost check. It must not be tuned on the final evaluation window.

The Worker now records a scan for each unpaused scheduled market snapshot. A
scan is idempotent by symbol, snapshot time, schema version, and prefilter
version. No-candidate scans do not reserve or spend a TypeSafe request. Candidate
requests reserve the `paper_trade_decision` stage under the existing daily cap;
blocked requests and no-trade answers are retained in D1. Historical direction
forecast rows remain available for the legacy report, but the Worker no longer
creates new scheduled direction forecasts. The local legacy CLI is unchanged.

Every scan records one of:

- `candidate_sent`: the candidate and exact snapshot sent to Jev;
- `no_candidate`: deterministic prefilter did not qualify, with reason code;
- `blocked`: usage, stale/missing data, risk, cost, or policy checks stopped it.

Jev can explicitly return `no_trade`. Missing or malformed fields, stale critical
data, unsupported policies, and failed cost/risk checks all fail closed. There is
no forced trade and no forced call at every 15-minute, hourly, or daily boundary.

## Paper execution contract

The first simulator version is long-only BTC spot, with no leverage, exchange
credentials, or live order path. Size is a fixed configured quote notional, so
model confidence cannot silently increase exposure. The simulator permits at
most one open paper position per symbol until overlapping-position behavior is
specified and evaluated.

- Entry occurs at the first eligible one-minute candle open after the decision
  timestamp. A decision never fills at its own anchor price.
- A versioned policy defines stop, target, and maximum holding time. Exits use
  subsequent candles only.
- Entry and exit P&L records include fee, spread, and slippage assumptions
  separately. Cost inputs and their version are frozen with the proposal.
- If one candle touches both stop and target, assume the stop occurs first. If a
  candle gaps through a level, use the worse executable open price. These rules
  prevent optimistic treatment of candle ambiguity.
- Missing or unaligned target data remains pending or becomes explicitly
  unpriceable; it is never silently counted as a win, loss, or zero return.
- A unique trade ID makes retries and reprocessing idempotent. Each fill and
  settlement links back to its proposal and source candles.

## Evaluation protocol

Evaluation uses chronological walk-forward windows. Any policy choice,
profitability threshold, or prefilter threshold is selected on earlier training
and validation windows, then frozen before the following test window. The final
holdout is not used to change questions, features, or thresholds.

Each comparison uses the same candidate events, position size, entry/exit rules,
data window, and cost model. Baselines are:

1. no trades;
2. buy-and-hold for the evaluated period;
3. a simple deterministic market rule;
4. the existing direction-only forecast translated through the same paper
   execution rules.

Trade results report net expectancy per trade, cumulative net return, maximum
drawdown, profit factor, trade count, exposure/time in market, and uncertainty
intervals. Forecast accuracy, Brier score, and log loss remain separate
diagnostics. Reports show sample counts and make no edge claim when data is thin
or uncertainty spans both useful and harmful results.

## Implementation order

1. Define this versioned decision/proposal contract and persist `no_trade` outcomes.
2. Add the deterministic, cost-aware paper execution ledger.
3. Add walk-forward evaluation and fixed baselines.
4. Show proposals, skipped candidates, costs, positions, and net outcomes in the
   dashboard.
5. Only then run controlled feature/model/data experiments from issue #3.

## Non-goals for the first release

- Live exchange integration, API keys, or automated order placement.
- Leverage, shorts, funding, liquidation, partial fills, or portfolio allocation.
- Claims that model confidence guarantees profit or that a small backtest sample
  demonstrates a durable edge.
- Adding indicators, providers, or macro sources without measuring their
  incremental out-of-sample value and cost.
