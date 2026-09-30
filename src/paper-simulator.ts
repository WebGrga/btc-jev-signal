import type { Candle } from "./types.js";
import { PAPER_POLICIES, type PaperPolicyId, type PaperTradeProposal } from "./paper-trade.js";

export type PaperTradeStatus = "pending_entry" | "open" | "closed" | "skipped" | "unpriceable";
export type PaperExitReason = "stop" | "stop_gap" | "target" | "time_limit";

export interface PaperFill {
  timestamp_utc: string;
  candle_open_time_utc: string;
  raw_price: number;
  effective_price: number;
  fee_quote: number;
  spread_cost_quote: number;
  slippage_cost_quote: number;
}

export interface PaperTradePosition {
  trade_schema_version: "paper_trade_position_v1";
  trade_id: string;
  proposal_id: string;
  proposal: PaperTradeProposal;
  candidate_event_id: string;
  symbol: string;
  quote_asset: string;
  policy_id: PaperPolicyId | null;
  status: PaperTradeStatus;
  status_reason: string | null;
  quote_notional: number;
  created_at_utc: string;
  updated_at_utc: string;
  entry: PaperFill | null;
  exit: PaperFill | null;
  stop_price: number | null;
  target_price: number | null;
  quantity_btc: number | null;
  exit_reason: PaperExitReason | null;
  gross_pnl_quote: number | null;
  fees_quote: number | null;
  spread_cost_quote: number | null;
  slippage_cost_quote: number | null;
  net_pnl_quote: number | null;
  net_return_pct: number | null;
  last_processed_candle_open_ms: number | null;
  source_candles: Candle[];
}

export function paperTradeId(proposalId: string): string {
  return `paper:${proposalId}`;
}

function iso(ms: number): string { return new Date(ms).toISOString(); }
function finitePositive(value: number): boolean { return Number.isFinite(value) && value > 0; }

function fillAt(
  timestampMs: number,
  rawPrice: number,
  position: PaperTradePosition,
  proposal: PaperTradeProposal,
  isEntry: boolean,
): PaperFill {
  const halfSpread = proposal.costs.spread_bps_round_trip / 2 / 10_000;
  const slippage = proposal.costs.slippage_bps_per_side / 10_000;
  const effectivePrice = rawPrice * (isEntry ? 1 + halfSpread + slippage : 1 - halfSpread - slippage);
  const quantity = position.quantity_btc ?? position.quote_notional / effectivePrice;
  const fee = quantity * rawPrice * proposal.costs.taker_fee_bps_per_side / 10_000;
  return {
    timestamp_utc: iso(timestampMs),
    candle_open_time_utc: iso(timestampMs),
    raw_price: rawPrice,
    effective_price: effectivePrice,
    fee_quote: fee,
    spread_cost_quote: quantity * rawPrice * halfSpread,
    slippage_cost_quote: quantity * rawPrice * slippage,
  };
}

function blankPosition(proposal: PaperTradeProposal, notional: number, nowMs: number): PaperTradePosition {
  const tradeId = paperTradeId(proposal.proposal_id);
  return {
    trade_schema_version: "paper_trade_position_v1",
    trade_id: tradeId,
    proposal_id: proposal.proposal_id,
    proposal,
    candidate_event_id: proposal.candidate_event_id,
    symbol: proposal.symbol,
    quote_asset: proposal.quote_asset,
    policy_id: proposal.selected_policy_id,
    status: "pending_entry",
    status_reason: null,
    quote_notional: notional,
    created_at_utc: iso(nowMs),
    updated_at_utc: iso(nowMs),
    entry: null,
    exit: null,
    stop_price: null,
    target_price: null,
    quantity_btc: null,
    exit_reason: null,
    gross_pnl_quote: null,
    fees_quote: null,
    spread_cost_quote: null,
    slippage_cost_quote: null,
    net_pnl_quote: null,
    net_return_pct: null,
    last_processed_candle_open_ms: null,
    source_candles: [],
  };
}

function invalid(position: PaperTradePosition, reason: string, nowMs: number): PaperTradePosition {
  return { ...position, status: "unpriceable", status_reason: reason, updated_at_utc: iso(nowMs) };
}

export function advancePaperTrade(
  proposal: PaperTradeProposal,
  candles: readonly Candle[],
  quoteNotional: number,
  nowMs = Date.now(),
): PaperTradePosition {
  let position = blankPosition(proposal, quoteNotional, nowMs);
  if (!proposal.eligible || !proposal.selected_policy_id || !proposal.action.startsWith("enter_long:")) {
    return { ...position, status: "skipped", status_reason: proposal.eligibility_reason ?? proposal.reason_code ?? "not_eligible" };
  }
  if (!finitePositive(quoteNotional) || !finitePositive(proposal.anchor_price) || !finitePositive(proposal.costs.estimated_round_trip_bps) || !finitePositive(proposal.atr_4h_usdt)) {
    return invalid(position, "invalid_proposal_or_sizing", nowMs);
  }

  const decisionMs = Date.parse(proposal.decision_timestamp_utc);
  const entryOpenMs = decisionMs + 60_000;
  const policy = PAPER_POLICIES[proposal.selected_policy_id];
  const atr = proposal.atr_4h_usdt;
  const sorted = [...candles].filter((candle) => candle.openTimeMs >= entryOpenMs && candle.closeTimeMs <= nowMs).sort((a, b) => a.openTimeMs - b.openTimeMs);
  const first = sorted[0];
  if (!first) {
    return nowMs < entryOpenMs + 60_000
      ? { ...position, updated_at_utc: iso(nowMs) }
      : invalid(position, "missing_entry_candle", nowMs);
  }
  if (first.openTimeMs !== entryOpenMs || first.closeTimeMs !== first.openTimeMs + 59_999) {
    return invalid(position, "missing_or_unaligned_entry_candle", nowMs);
  }
  if (![first.open, first.high, first.low, first.close].every(finitePositive) || first.high < first.low || first.high < Math.max(first.open, first.close) || first.low > Math.min(first.open, first.close)) {
    return invalid(position, "invalid_entry_candle", nowMs);
  }

  const entryFill = fillAt(first.openTimeMs, first.open, position, proposal, true);
  const quantity = quoteNotional / entryFill.effective_price;
  const stopPrice = first.open - policy.stop_atr * atr;
  const targetPrice = first.open + policy.target_atr * atr;
  position = {
    ...position,
    status: "open",
    entry: entryFill,
    stop_price: stopPrice,
    target_price: targetPrice,
    quantity_btc: quantity,
    last_processed_candle_open_ms: first.openTimeMs,
    source_candles: [first],
  };
  const maxExitMs = first.openTimeMs + policy.max_holding_minutes * 60_000;

  for (let index = 1; index < sorted.length; index += 1) {
    const candle = sorted[index]!;
    const previousOpenMs = sorted[index - 1]!.openTimeMs;
    if (candle.openTimeMs !== previousOpenMs + 60_000 || candle.closeTimeMs !== candle.openTimeMs + 59_999) {
      return invalid(position, "missing_or_unaligned_candle", nowMs);
    }
    if (![candle.open, candle.high, candle.low, candle.close].every(finitePositive) || candle.high < candle.low || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) {
      return invalid(position, "invalid_candle", nowMs);
    }
    position.last_processed_candle_open_ms = candle.openTimeMs;
    position.source_candles.push(candle);
    let rawExit: number | null = null;
    let reason: PaperExitReason | null = null;

    if (candle.openTimeMs >= maxExitMs) {
      rawExit = candle.open;
      reason = "time_limit";
    } else if (candle.open <= stopPrice) {
      rawExit = candle.open;
      reason = "stop_gap";
    } else if (candle.open >= targetPrice) {
      rawExit = targetPrice;
      reason = "target";
    } else if (candle.low <= stopPrice && candle.high >= targetPrice) {
      rawExit = stopPrice;
      reason = "stop";
    } else if (candle.low <= stopPrice) {
      rawExit = stopPrice;
      reason = "stop";
    } else if (candle.high >= targetPrice) {
      rawExit = targetPrice;
      reason = "target";
    }

    if (rawExit !== null && reason !== null) {
      const exitFill = fillAt(candle.openTimeMs, rawExit, position, proposal, false);
      const grossPnl = quantity * (rawExit - first.open);
      const fees = entryFill.fee_quote + exitFill.fee_quote;
      const spreadCost = entryFill.spread_cost_quote + exitFill.spread_cost_quote;
      const slippageCost = entryFill.slippage_cost_quote + exitFill.slippage_cost_quote;
      const net = grossPnl - fees - spreadCost - slippageCost;
      return {
        ...position,
        status: "closed",
        status_reason: null,
        updated_at_utc: iso(nowMs),
        exit: exitFill,
        exit_reason: reason,
        gross_pnl_quote: grossPnl,
        fees_quote: fees,
        spread_cost_quote: spreadCost,
        slippage_cost_quote: slippageCost,
        net_pnl_quote: net,
        net_return_pct: net / quoteNotional * 100,
      };
    }
  }

  if (nowMs >= maxExitMs && position.last_processed_candle_open_ms !== null && position.last_processed_candle_open_ms < maxExitMs) {
    return invalid(position, "missing_time_exit_candle", nowMs);
  }
  position.updated_at_utc = iso(nowMs);
  return position;
}
