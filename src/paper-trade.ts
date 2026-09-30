import { choice, noul, TypeSafeClient, type JsonValue } from "@typesafe-ai/sdk";
import type { ExperimentState } from "./experiment-types.js";
import type { RequestPermit } from "./experiment-jev.js";

export const PAPER_TRADE_SCHEMA_VERSION = "paper_trade_proposal_v1" as const;
export const PAPER_TRADE_POLICY_VERSION = "btc_spot_long_atr_v1" as const;
export const PAPER_COST_MODEL_VERSION = "conservative_spot_costs_v1" as const;

export const PAPER_POLICIES = {
  atr_1x_1_5x_240m: { stop_atr: 1, target_atr: 1.5, max_holding_minutes: 240 },
  atr_1x_2x_240m: { stop_atr: 1, target_atr: 2, max_holding_minutes: 240 },
} as const;

export type PaperPolicyId = keyof typeof PAPER_POLICIES;
export type PaperAction = "no_trade" | `enter_long:${PaperPolicyId}`;
export type PaperNoTradeReason =
  | "missing_data"
  | "stale_data"
  | "excessive_estimated_cost"
  | "weak_evidence"
  | "unsupported_policy"
  | "risk_limit"
  | "malformed_model_output"
  | "jev_no_trade";
export type ScanOutcome = "candidate_sent" | "no_candidate" | "blocked";

export interface PaperTradeCosts {
  model_version: typeof PAPER_COST_MODEL_VERSION;
  taker_fee_bps_per_side: number;
  spread_bps_round_trip: number;
  slippage_bps_per_side: number;
  estimated_round_trip_bps: number;
}

export interface PaperTradeProposal {
  schema_version: typeof PAPER_TRADE_SCHEMA_VERSION;
  proposal_id: string;
  candidate_event_id: string;
  snapshot_id: string;
  source_forecast_ids: string[];
  created_at_utc: string;
  policy_version: typeof PAPER_TRADE_POLICY_VERSION;
  instrument: "BTC spot";
  symbol: ExperimentState["snapshot"]["symbol"];
  quote_asset: ExperimentState["snapshot"]["quote_asset"];
  decision_timestamp_utc: string;
  anchor_price: number;
  atr_4h_usdt: number;
  action: PaperAction;
  action_probabilities: Record<PaperAction, number>;
  typesafe_confidence: number;
  selected_policy_id: PaperPolicyId | null;
  net_positive_probabilities: Record<PaperPolicyId, number>;
  selected_net_positive_probability: number | null;
  model_id: string;
  reason_code: PaperNoTradeReason | null;
  risk_codes: string[];
  data_freshness_ms: number;
  costs: PaperTradeCosts;
  eligible: boolean;
  eligibility_reason: PaperNoTradeReason | null;
  paper_trade_id: string | null;
  outcome_id: string | null;
}

export interface PaperTradeScan {
  scan_schema_version: "paper_trade_scan_v1";
  scan_id: string;
  snapshot_id: string;
  scanned_at_utc: string;
  prefilter_version: "atr_cost_event_v1";
  outcome: ScanOutcome;
  reason_code: string | null;
  estimated_move_bps: number | null;
  costs: PaperTradeCosts | null;
  market_state: ExperimentState;
  request: RequestPermit & { stage: "paper_trade_decision" } | null;
  proposal: PaperTradeProposal | null;
}

export interface CandidateAssessment {
  candidate: boolean;
  reason: string | null;
  dataFreshnessMs: number;
  estimatedMoveBps: number;
  costs: PaperTradeCosts;
}

const ACTION_CRITERIA = {
  no_trade: "Do not open a position now. Choose this when evidence is weak, the estimated costs dominate, or conditions are unsuitable.",
  "enter_long:atr_1x_1_5x_240m": "Open a long BTC spot paper position using the fixed v1 policy: stop at 1 ATR below entry, target at 1.5 ATR above entry, maximum hold 240 minutes.",
  "enter_long:atr_1x_2x_240m": "Open a long BTC spot paper position using the fixed v1 policy: stop at 1 ATR below entry, target at 2 ATR above entry, maximum hold 240 minutes.",
} as const;

const TAKER_FEE_BPS_PER_SIDE = 80;
const SLIPPAGE_BPS_PER_SIDE = 5;
const MAX_STATE_AGE_MS = 20 * 60_000;
const MAX_ESTIMATED_COST_BPS = 200;

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizedDistribution(value: unknown, labels: readonly string[]): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== labels.length || labels.some((label) => !finiteProbability(record[label]))) return false;
  const total = labels.reduce((sum, label) => sum + (record[label] as number), 0);
  return Math.abs(total - 1) <= 0.01;
}

export function assessPaperTradeCandidate(state: ExperimentState, nowMs = Date.now()): CandidateAssessment {
  const snapshotMs = Date.parse(state.snapshot.timestamp_utc);
  const collectedMs = Date.parse(state.snapshot.collected_at_utc);
  const completedMs = Date.parse(state.timeframes["15m"].calculated_through_utc);
  const orderBook = state.order_book;
  const orderBookAsOfMs = Date.parse(orderBook?.as_of_utc ?? "");
  const spread = orderBook?.available ? orderBook.spread_bps : null;
  const atrPct = state.timeframes["4h"]?.atr_14_pct;
  const atrUsd = state.timeframes["4h"]?.atr_14_usdt;
  const freshness = nowMs - snapshotMs;
  const costs: PaperTradeCosts = {
    model_version: PAPER_COST_MODEL_VERSION,
    taker_fee_bps_per_side: TAKER_FEE_BPS_PER_SIDE,
    spread_bps_round_trip: finiteNonNegative(spread) ? spread : 0,
    slippage_bps_per_side: SLIPPAGE_BPS_PER_SIDE,
    estimated_round_trip_bps: 2 * TAKER_FEE_BPS_PER_SIDE + (finiteNonNegative(spread) ? spread : 0) + 2 * SLIPPAGE_BPS_PER_SIDE,
  };
  const noCandidate = (reason: string, candidate = false): CandidateAssessment => ({
    candidate, reason, dataFreshnessMs: freshness, estimatedMoveBps: finiteProbability(atrPct) ? atrPct * 100 : 0, costs,
  });

  if (![snapshotMs, collectedMs, completedMs].every(Number.isFinite) || !finitePositive(state.snapshot.anchor_price_usdt) || !finitePositive(atrPct) || !finitePositive(atrUsd)) {
    return noCandidate("missing_data");
  }
  if (snapshotMs > nowMs + 60_000 || collectedMs > nowMs + 60_000 || collectedMs < snapshotMs - 60_000 || nowMs - collectedMs > MAX_STATE_AGE_MS || nowMs - snapshotMs > MAX_STATE_AGE_MS || completedMs > snapshotMs || snapshotMs - completedMs > 2 * 15 * 60_000) {
    return noCandidate("stale_data");
  }
  if (!orderBook?.available || !finiteNonNegative(spread) || !Number.isFinite(orderBookAsOfMs)) return noCandidate("missing_order_book");
  if (orderBookAsOfMs > nowMs + 60_000 || nowMs - orderBookAsOfMs > 2 * 60_000) return noCandidate("stale_data");
  if (costs.estimated_round_trip_bps > MAX_ESTIMATED_COST_BPS) return noCandidate("excessive_estimated_cost");
  const estimatedMoveBps = atrPct * 100 * 2;
  if (estimatedMoveBps < costs.estimated_round_trip_bps) return noCandidate("move_below_estimated_cost");
  return { candidate: true, reason: null, dataFreshnessMs: freshness, estimatedMoveBps, costs };
}

function toAction(value: string): PaperAction | null {
  if (value === "no_trade" || value === "enter_long:atr_1x_1_5x_240m" || value === "enter_long:atr_1x_2x_240m") return value;
  return null;
}

function makeClient(apiKey?: string): TypeSafeClient {
  if (!apiKey?.trim()) throw new Error("TYPESAFE_API_KEY is not set.");
  return new TypeSafeClient({ apiKey, timeout: 15_000, logLevel: "warn", retry: { maxRetries: 0 } });
}

export interface DecidePaperTradeOptions {
  apiKey?: string;
  beforeRequest?: () => Promise<RequestPermit>;
  now?: () => Date;
  sourceForecastIds?: string[];
  riskBlocked?: string | null;
}

export type DecidePaperTradeResult =
  | { kind: "no_candidate"; assessment: CandidateAssessment }
  | { kind: "blocked"; assessment: CandidateAssessment; request: RequestPermit }
  | { kind: "candidate_sent"; assessment: CandidateAssessment; request: RequestPermit; proposal: PaperTradeProposal };

interface ModelJudgment {
  model?: unknown;
  answers?: {
    action?: unknown;
    net_positive_atr_1x_1_5x_240m?: unknown;
    net_positive_atr_1x_2x_240m?: unknown;
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function buildPaperTradeProposal(
  state: ExperimentState,
  assessment: CandidateAssessment,
  judgment: ModelJudgment,
  now = new Date(),
  sourceForecastIds: string[] = [],
): PaperTradeProposal {
  const answers = record(judgment.answers);
  const actionAnswer = record(answers?.action);
  const rawAction = actionAnswer?.choice;
  const action = typeof rawAction === "string" ? toAction(rawAction) : null;
  const actionProbabilities = actionAnswer?.probabilities;
  const confidence = actionAnswer?.confidence;
  const n1 = record(answers?.net_positive_atr_1x_1_5x_240m)?.noul;
  const n2 = record(answers?.net_positive_atr_1x_2x_240m)?.noul;
  const actions = Object.keys(ACTION_CRITERIA) as PaperAction[];
  const probabilitiesValid = normalizedDistribution(actionProbabilities, actions);
  const netProbabilities = {
    atr_1x_1_5x_240m: finiteProbability(n1) ? n1 : 0,
    atr_1x_2x_240m: finiteProbability(n2) ? n2 : 0,
  };
  const selectedPolicy = action?.startsWith("enter_long:") ? action.slice("enter_long:".length) as PaperPolicyId : null;
  const malformed = !action || !probabilitiesValid || !finiteProbability(confidence) || !finiteProbability(n1) || !finiteProbability(n2) || Boolean(selectedPolicy && !Object.hasOwn(PAPER_POLICIES, selectedPolicy));
  const snapshotId = `${state.snapshot.symbol}:${state.snapshot.timestamp_utc}:${state.schema_version}`;
  const candidateEventId = `candidate:${snapshotId}:atr_cost_event_v1`;
  const selectedNetPositive = selectedPolicy ? netProbabilities[selectedPolicy] : null;
  const explicitlyNoTrade = action === "no_trade";
  const eligible = !malformed && !explicitlyNoTrade && selectedPolicy !== null;
  const normalizedActionProbabilities: Record<PaperAction, number> = probabilitiesValid
    ? actionProbabilities as Record<PaperAction, number>
    : { no_trade: 1, "enter_long:atr_1x_1_5x_240m": 0, "enter_long:atr_1x_2x_240m": 0 };
  return {
    schema_version: PAPER_TRADE_SCHEMA_VERSION,
    proposal_id: `proposal:${candidateEventId}:${PAPER_TRADE_POLICY_VERSION}`,
    candidate_event_id: candidateEventId,
    snapshot_id: snapshotId,
    source_forecast_ids: sourceForecastIds,
    created_at_utc: now.toISOString(),
    policy_version: PAPER_TRADE_POLICY_VERSION,
    instrument: "BTC spot",
    symbol: state.snapshot.symbol,
    quote_asset: state.snapshot.quote_asset,
    decision_timestamp_utc: state.snapshot.timestamp_utc,
    anchor_price: state.snapshot.anchor_price_usdt,
    atr_4h_usdt: state.timeframes["4h"].atr_14_usdt,
    action: malformed ? "no_trade" : action!,
    action_probabilities: normalizedActionProbabilities,
    typesafe_confidence: malformed ? 0 : confidence as number,
    selected_policy_id: malformed ? null : selectedPolicy,
    net_positive_probabilities: netProbabilities,
    selected_net_positive_probability: malformed ? null : selectedNetPositive,
    model_id: typeof judgment.model === "string" ? judgment.model : "unknown",
    reason_code: malformed ? "malformed_model_output" : explicitlyNoTrade ? "jev_no_trade" : null,
    risk_codes: [],
    data_freshness_ms: assessment.dataFreshnessMs,
    costs: assessment.costs,
    eligible,
    eligibility_reason: malformed ? "malformed_model_output" : explicitlyNoTrade ? "jev_no_trade" : eligible ? null : "unsupported_policy",
    paper_trade_id: null,
    outcome_id: null,
  };
}

export async function decidePaperTrade(state: ExperimentState, options: DecidePaperTradeOptions = {}): Promise<DecidePaperTradeResult> {
  const now = options.now?.() ?? new Date();
  const assessment = assessPaperTradeCandidate(state, now.getTime());
  if (!assessment.candidate) {
    if (assessment.reason === "stale_data" || assessment.reason === "missing_data" || assessment.reason === "missing_order_book") {
      return { kind: "blocked", assessment, request: { allowed: false, reason: assessment.reason } };
    }
    return { kind: "no_candidate", assessment };
  }
  if (options.riskBlocked) return { kind: "blocked", assessment, request: { allowed: false, reason: options.riskBlocked } };
  const permit = await options.beforeRequest?.() ?? { allowed: true };
  if (!permit.allowed) return { kind: "blocked", assessment, request: permit };

  const policies = Object.entries(PAPER_POLICIES).map(([id, policy]) => ({
    policy_id: id,
    stop_atr: policy.stop_atr,
    target_atr: policy.target_atr,
    max_holding_minutes: policy.max_holding_minutes,
    cost_model: assessment.costs,
  }));
  const response = await makeClient(options.apiKey).systemOne({
    state: {
      market: state as unknown as JsonValue,
      candidate: { estimated_move_bps: assessment.estimatedMoveBps, data_freshness_ms: assessment.dataFreshnessMs },
      policy_library: policies,
      constraints: { long_only: true, no_leverage: true, trade_size_is_fixed_by_code: true, paper_only: true },
    } as unknown as Record<string, JsonValue>,
    questions: {
      action: choice({ task: "Choose whether the fixed BTC spot paper policies justify opening a long position now or to make no trade.", instructions: "Use only supplied market and candidate data. The candidate policies and cost assumptions are fixed and listed in policy_library. Do not invent prices, sizing, risk limits, or policies. A no_trade answer is valid and preferred when evidence does not support a cost-aware opportunity." }, ACTION_CRITERIA),
      net_positive_atr_1x_1_5x_240m: noul({ task: "Would the exact policy atr_1x_1_5x_240m produce positive net P&L after the listed costs if entered now?", policy: "Long BTC spot; stop 1 ATR below entry, target 1.5 ATR above entry, exit after at most 240 minutes. Include the supplied entry and exit fees, spread, and slippage." }, { true: "The exact policy has positive net P&L after listed costs.", false: "The exact policy does not have positive net P&L after listed costs." }),
      net_positive_atr_1x_2x_240m: noul({ task: "Would the exact policy atr_1x_2x_240m produce positive net P&L after the listed costs if entered now?", policy: "Long BTC spot; stop 1 ATR below entry, target 2 ATR above entry, exit after at most 240 minutes. Include the supplied entry and exit fees, spread, and slippage." }, { true: "The exact policy has positive net P&L after listed costs.", false: "The exact policy does not have positive net P&L after listed costs." }),
    },
  });
  const proposal = buildPaperTradeProposal(state, assessment, response, now, options.sourceForecastIds);
  return {
    kind: "candidate_sent",
    assessment,
    request: permit,
    proposal,
  };
}

export function makePaperTradeScan(state: ExperimentState, result: DecidePaperTradeResult, scannedAt = new Date()): PaperTradeScan {
  const snapshotId = `${state.snapshot.symbol}:${state.snapshot.timestamp_utc}:${state.schema_version}`;
  const scanId = `scan:${snapshotId}:atr_cost_event_v1`;
  return {
    scan_schema_version: "paper_trade_scan_v1",
    scan_id: scanId,
    snapshot_id: snapshotId,
    scanned_at_utc: scannedAt.toISOString(),
    prefilter_version: "atr_cost_event_v1",
    outcome: result.kind,
    reason_code: result.kind === "candidate_sent" ? result.proposal.reason_code : result.kind === "no_candidate" ? result.assessment.reason : result.assessment.reason ?? result.request.reason ?? "request_blocked",
    estimated_move_bps: result.assessment.estimatedMoveBps,
    costs: result.assessment.costs,
    market_state: state,
    request: result.kind === "candidate_sent" ? { ...result.request, stage: "paper_trade_decision" } : result.kind === "blocked" ? { ...result.request, stage: "paper_trade_decision" } : null,
    proposal: result.kind === "candidate_sent" ? result.proposal : null,
  };
}
