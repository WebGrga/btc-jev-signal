import type { Forecast, PredictionBatch } from "./experiment-types.js";
import type { PaperTradePosition } from "./paper-simulator.js";
import type { PaperTradeScan } from "./paper-trade.js";

const MINIMUM_EVIDENCE_TRADES = 30;
const MINIMUM_TRAINING_TRADES = 20;

export interface PaperStrategyMetrics {
  strategy: "jev_policy" | "no_trade" | "buy_and_hold" | "four_hour_momentum" | "direction_only_forecast";
  sample_windows: number;
  trade_count: number;
  pending_or_unpriceable: number;
  total_net_pnl_quote: number | null;
  net_expectancy_quote_per_trade: number | null;
  maximum_drawdown_quote: number | null;
  profit_factor: number | null;
  exposure_minutes: number;
  expectancy_95pct_interval_quote: [number, number] | null;
  evidence_status: "insufficient_sample" | "descriptive_only" | "sufficient_sample" | "unavailable";
}

export interface PaperEvaluationFold {
  month_utc: string;
  training_trades_available: number;
  status: "warmup" | "out_of_sample";
  strategies: PaperStrategyMetrics[];
}

export interface PaperEvaluationReport {
  generated_at_utc: string;
  evaluation_version: "paper_walk_forward_v1";
  policy_version: string;
  cost_model_version: string;
  minimum_training_trades: number;
  minimum_evidence_trades: number;
  closed_trade_count: number;
  pending_trade_count: number;
  skipped_trade_count: number;
  unpriceable_trade_count: number;
  folds: PaperEvaluationFold[];
  out_of_sample_strategies: PaperStrategyMetrics[];
  methodology_notes: string[];
}

interface ClosedWindow {
  position: PaperTradePosition;
  scan: PaperTradeScan;
  month: string;
  durationMinutes: number;
  jevPnl: number;
  buyHoldPnl: number;
  momentumPnl: number;
  momentumTraded: boolean;
  directionForecast: Forecast | null;
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function monthOf(timestamp: string): string {
  return timestamp.slice(0, 7);
}

function matchingDirectionForecast(position: PaperTradePosition, batches: readonly PredictionBatch[]): Forecast | null {
  const timestamp = position.proposal.decision_timestamp_utc;
  return batches
    .filter((batch) => batch.state.snapshot.timestamp_utc === timestamp)
    .flatMap((batch) => batch.forecasts)
    .find((forecast) => forecast.stage === "parallel_horizons" && forecast.horizon === "4h") ?? null;
}

function netLongPnl(position: PaperTradePosition, exitRawPrice: number): number {
  const entryRaw = position.entry!.raw_price;
  const proposal = position.proposal;
  const quantity = position.quote_notional / position.entry!.effective_price;
  const feeBps = proposal.costs.taker_fee_bps_per_side / 10_000;
  const halfSpread = proposal.costs.spread_bps_round_trip / 2 / 10_000;
  const slippage = proposal.costs.slippage_bps_per_side / 10_000;
  const fees = quantity * (entryRaw + exitRawPrice) * feeBps;
  const spread = quantity * (entryRaw + exitRawPrice) * halfSpread;
  const slip = quantity * (entryRaw + exitRawPrice) * slippage;
  return quantity * (exitRawPrice - entryRaw) - fees - spread - slip;
}

function makeWindow(
  position: PaperTradePosition,
  scan: PaperTradeScan,
  batches: readonly PredictionBatch[],
): ClosedWindow | null {
  if (position.status !== "closed" || !position.entry || !position.exit || !position.exit_reason) return null;
  const decisionMs = Date.parse(position.proposal.decision_timestamp_utc);
  const exitMs = Date.parse(position.exit.candle_open_time_utc);
  const candles = position.source_candles;
  const entryIndex = candles.findIndex((candle) => candle.openTimeMs === Date.parse(position.entry!.candle_open_time_utc));
  const exitIndex = candles.findIndex((candle) => candle.openTimeMs === exitMs);
  if (entryIndex < 0 || exitIndex < entryIndex) return null;
  const start = candles[entryIndex]!.open;
  const exit = candles[exitIndex]!.open;
  const momentum = scan.market_state.returns_pct["4h"] > 0;
  return {
    position,
    scan,
    month: monthOf(new Date(decisionMs).toISOString()),
    durationMinutes: (exitMs - Date.parse(position.entry.candle_open_time_utc)) / 60_000,
    jevPnl: position.net_pnl_quote ?? 0,
    buyHoldPnl: netLongPnl(position, exit),
    momentumPnl: momentum ? netLongPnl(position, exit) : 0,
    momentumTraded: momentum,
    directionForecast: matchingDirectionForecast(position, batches),
  };
}

function sampleInterval(values: readonly number[]): [number, number] | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return [round(mean - margin), round(mean + margin)];
}

function metrics(
  strategy: PaperStrategyMetrics["strategy"],
  values: readonly { pnl: number; traded: boolean; pending: boolean; duration: number }[],
  unavailable = false,
): PaperStrategyMetrics {
  const completed = values.filter((row) => !row.pending);
  const tradePnls = completed.filter((row) => row.traded).map((row) => row.pnl);
  if (unavailable || completed.length === 0) {
    return {
      strategy,
      sample_windows: completed.length,
      trade_count: tradePnls.length,
      pending_or_unpriceable: values.length - completed.length,
      total_net_pnl_quote: null,
      net_expectancy_quote_per_trade: null,
      maximum_drawdown_quote: null,
      profit_factor: null,
      exposure_minutes: 0,
      expectancy_95pct_interval_quote: null,
      evidence_status: "unavailable",
    };
  }
  const wins = tradePnls.filter((pnl) => pnl > 0).reduce((sum, pnl) => sum + pnl, 0);
  const losses = -tradePnls.filter((pnl) => pnl < 0).reduce((sum, pnl) => sum + pnl, 0);
  const completedPnls = completed.map((row) => row.pnl);
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const pnl of completedPnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  const expectation = tradePnls.length ? tradePnls.reduce((sum, pnl) => sum + pnl, 0) / tradePnls.length : null;
  const evidence = tradePnls.length >= MINIMUM_EVIDENCE_TRADES ? "sufficient_sample" : tradePnls.length > 0 ? "descriptive_only" : "insufficient_sample";
  return {
    strategy,
    sample_windows: completed.length,
    trade_count: tradePnls.length,
    pending_or_unpriceable: values.length - completed.length,
    total_net_pnl_quote: round(completedPnls.reduce((sum, pnl) => sum + pnl, 0)),
    net_expectancy_quote_per_trade: expectation === null ? null : round(expectation),
    maximum_drawdown_quote: round(drawdown),
    profit_factor: losses === 0 ? (wins > 0 ? null : 0) : round(wins / losses),
    exposure_minutes: completed.filter((row) => row.traded).reduce((sum, row) => sum + row.duration, 0),
    expectancy_95pct_interval_quote: sampleInterval(tradePnls),
    evidence_status: evidence,
  };
}

function foldMetrics(windows: readonly ClosedWindow[]): PaperStrategyMetrics[] {
  const rows = (pick: (window: ClosedWindow) => { pnl: number; traded: boolean }[]) => windows.map((window) => {
    const result = pick(window)[0]!;
    return { ...result, pending: false, duration: window.durationMinutes };
  });
  const directionRows = windows.filter((window) => window.directionForecast !== null).map((window) => {
    const forecast = window.directionForecast!;
    const chosenHigher = forecast.choice === "higher";
    const traded = chosenHigher;
    return { pnl: traded ? window.buyHoldPnl : 0, traded, pending: false, duration: window.durationMinutes };
  });
  return [
    metrics("jev_policy", rows((window) => [{ pnl: window.jevPnl, traded: true } ])),
    metrics("no_trade", rows(() => [{ pnl: 0, traded: false }])),
    metrics("buy_and_hold", rows((window) => [{ pnl: window.buyHoldPnl, traded: true }])),
    metrics("four_hour_momentum", rows((window) => [{ pnl: window.momentumPnl, traded: window.momentumTraded }])),
    metrics("direction_only_forecast", directionRows, directionRows.length === 0),
  ];
}

export function buildPaperEvaluation(
  scans: readonly PaperTradeScan[],
  positions: readonly PaperTradePosition[],
  batches: readonly PredictionBatch[] = [],
  generatedAt = new Date(),
): PaperEvaluationReport {
  const scansByProposal = new Map<string, PaperTradeScan>();
  for (const scan of scans) if (scan.proposal) scansByProposal.set(scan.proposal.proposal_id, scan);
  const windows = positions
    .map((position) => {
      const scan = scansByProposal.get(position.proposal_id);
      return scan ? makeWindow(position, scan, batches) : null;
    })
    .filter((window): window is ClosedWindow => window !== null)
    .sort((a, b) => a.position.proposal.decision_timestamp_utc.localeCompare(b.position.proposal.decision_timestamp_utc));
  const monthGroups = new Map<string, ClosedWindow[]>();
  for (const window of windows) monthGroups.set(window.month, [...(monthGroups.get(window.month) ?? []), window]);
  let priorTrades = 0;
  const folds: PaperEvaluationFold[] = [];
  const outOfSampleWindows: ClosedWindow[] = [];
  for (const [month, monthWindows] of [...monthGroups].sort(([a], [b]) => a.localeCompare(b))) {
    const status = priorTrades >= MINIMUM_TRAINING_TRADES ? "out_of_sample" : "warmup";
    folds.push({ month_utc: month, training_trades_available: priorTrades, status, strategies: status === "out_of_sample" ? foldMetrics(monthWindows) : [] });
    if (status === "out_of_sample") outOfSampleWindows.push(...monthWindows);
    priorTrades += monthWindows.length;
  }
  const closedTradeCount = positions.filter((position) => position.status === "closed").length;
  return {
    generated_at_utc: generatedAt.toISOString(),
    evaluation_version: "paper_walk_forward_v1",
    policy_version: "btc_spot_long_atr_v1",
    cost_model_version: "conservative_spot_costs_v1",
    minimum_training_trades: MINIMUM_TRAINING_TRADES,
    minimum_evidence_trades: MINIMUM_EVIDENCE_TRADES,
    closed_trade_count: closedTradeCount,
    pending_trade_count: positions.filter((position) => position.status === "pending_entry" || position.status === "open").length,
    skipped_trade_count: positions.filter((position) => position.status === "skipped").length,
    unpriceable_trade_count: positions.filter((position) => position.status === "unpriceable").length,
    folds,
    out_of_sample_strategies: foldMetrics(outOfSampleWindows),
    methodology_notes: [
      "Calendar-month walk-forward folds are chronological. Each test month can use only results from earlier months.",
      "The paper exit policies and all thresholds are fixed before collection; this version performs no fitted threshold selection.",
      "Buy-and-hold and 4h momentum use each Jev paper trade's same entry/exit window, sizing, and modeled costs; they are paired-window baselines.",
      "The direction-only forecast baseline appears only when a matching frozen 4h forecast exists for the exact proposal timestamp.",
      "Uncertainty intervals use a normal approximation and are descriptive. Fewer than 30 strategy trades cannot be labeled evidence of edge.",
      "Forecast accuracy, Brier score, and log loss remain separate direction-forecast diagnostics.",
    ],
  };
}

