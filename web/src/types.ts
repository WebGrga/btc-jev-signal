export type Horizon = "15m" | "1h" | "4h" | "eod";
export type Direction = "higher" | "lower";
export type ForecastStatus = "pending" | "correct" | "incorrect" | "tie";

export interface ForecastView {
  forecast_id: string;
  horizon: Horizon;
  origin_timestamp_utc: string;
  target_timestamp_utc: string;
  origin_price_usdt: number;
  choice: Direction;
  confidence: number;
  probabilities: Record<Direction, number>;
  stage: "parallel_horizons" | "eod_cascade";
  status: ForecastStatus;
  target_price_usdt: number | null;
  actual_direction: Direction | "unchanged" | null;
  actual_return_pct: number | null;
  brier_score: number | null;
  log_loss: number | null;
}

export interface TimeframeFeatures {
  interval: "15m" | "1h" | "4h";
  rsi_14: number;
  atr_14_usdt: number;
  atr_14_pct: number;
  completed_bar_return_pct: number;
  completed_4_bar_return_pct: number;
  calculated_through_utc: string;
  moving_averages_usdt: Record<"sma_20" | "sma_50" | "sma_200" | "ema_20" | "ema_50" | "ema_200", number>;
  anchor_distance_from_moving_average_pct: Record<"sma_20" | "sma_50" | "sma_200" | "ema_20" | "ema_50" | "ema_200", number>;
  macd_12_26_9: { line: number; signal: number; histogram: number };
  volume: {
    last_completed_bar_base_btc: number;
    last_completed_bar_quote_usdt: number;
    mean_20_bar_base_btc: number;
    latest_to_mean_20_bar_ratio: number;
  };
}

export interface ExperimentState {
  snapshot: {
    timestamp_utc: string;
    anchor_price_usdt: number;
    collection_lag_ms: number;
    cadence: "scheduled_15m" | "manual_once";
    anchor_price_source: string;
  };
  targets: { "15m": string; "1h": string; "4h": string; end_of_utc_day: string };
  returns_pct: Record<"1m" | "5m" | "15m" | "1h" | "4h", number>;
  timeframes: Record<"15m" | "1h" | "4h", TimeframeFeatures>;
  utc_session: {
    day_start_utc: string;
    day_end_utc: string;
    minutes_until_day_end: number;
    open_usdt: number;
    high_usdt: number;
    low_usdt: number;
    return_from_open_pct: number;
    base_volume_btc: number;
    quote_volume_usdt: number;
  };
  perpetual_futures: {
    available: boolean;
    mark_price_usdt: number | null;
    index_price_usdt: number | null;
    last_funding_rate: number | null;
    next_funding_time_utc: string | null;
    open_interest_btc: number | null;
    open_interest_notional_usdt: number | null;
    open_interest_as_of_utc: string | null;
    open_interest_change_pct: Record<"5m" | "15m" | "1h", number> | null;
    error: string | null;
  };
  liquidations: {
    available: boolean;
    event_count: number;
    long_liquidation_notional_usdt: number;
    short_liquidation_notional_usdt: number;
    total_liquidation_notional_usdt: number;
    observation_start_utc: string;
    observation_end_utc: string;
    observation_window_ms: number;
    error: string | null;
  };
  order_book: {
    available: boolean;
    imbalance: number | null;
    spread_bps: number | null;
    best_bid_usdt: number | null;
    best_ask_usdt: number | null;
    bid_notional_usdt: number | null;
    ask_notional_usdt: number | null;
    depth_levels: number;
    as_of_utc: string;
    error: string | null;
  };
  sources: Record<"spot" | "perpetual_futures" | "liquidations", string>;
}

export interface PredictionBatch {
  batch_id: string;
  state: ExperimentState;
}

export interface HorizonReport {
  horizon: Horizon | "overall";
  issued: number;
  settled: number;
  pending: number;
  scored: number;
  correct: number;
  accuracy: number | null;
  mean_brier_score: number | null;
  mean_log_loss: number | null;
  mean_chosen_probability: number | null;
  excluded_overlapping: number;
}

export interface DashboardData {
  generated_at_utc: string;
  experimental_only: true;
  disclaimer: string;
  latest_batch: PredictionBatch | null;
  latest_forecasts: ForecastView[];
  recent_forecasts: ForecastView[];
  probability_history: Array<{
    timestamp_utc: string;
    anchor_price_usdt: number;
    higher_probability: Partial<Record<Horizon, number>>;
  }>;
  report: {
    generated_at_utc: string;
    first_forecast_utc: string | null;
    last_forecast_utc: string | null;
    reports: HorizonReport[];
    note: string;
  };
  paper_evaluation: PaperEvaluationReport;
  recent_paper_scans: PaperTradeScan[];
  recent_paper_trades: PaperTradePosition[];
  schedule: Record<Horizon, { issue_every_minutes: number; expected_per_utc_day: number }>;
  methodology: {
    scoring_policy: "natural_non_overlapping_v1";
    target_price_source: string;
    legacy_overlapping_forecasts_retained: true;
  };
}

export type PaperStatus = "pending_entry" | "open" | "closed" | "skipped" | "unpriceable";

export interface PaperTradeProposal {
  proposal_id: string;
  decision_timestamp_utc: string;
  action: "no_trade" | `enter_long:${string}`;
  action_probabilities: Record<string, number>;
  typesafe_confidence: number;
  selected_net_positive_probability: number | null;
  selected_policy_id: string | null;
  eligible: boolean;
  eligibility_reason: string | null;
  reason_code: string | null;
  anchor_price: number;
  costs: {
    model_version: string;
    taker_fee_bps_per_side: number;
    spread_bps_round_trip: number;
    slippage_bps_per_side: number;
    estimated_round_trip_bps: number;
  };
}

export interface PaperTradeScan {
  scan_id: string;
  scanned_at_utc: string;
  outcome: "candidate_sent" | "no_candidate" | "blocked";
  reason_code: string | null;
  estimated_move_bps: number | null;
  proposal: PaperTradeProposal | null;
  market_state: ExperimentState;
}

export interface PaperTradePosition {
  trade_id: string;
  proposal_id: string;
  proposal: PaperTradeProposal;
  status: PaperStatus;
  status_reason: string | null;
  quote_notional: number;
  policy_id: string | null;
  entry: { timestamp_utc: string; raw_price: number; effective_price: number } | null;
  exit: { timestamp_utc: string; raw_price: number; effective_price: number } | null;
  exit_reason: string | null;
  gross_pnl_quote: number | null;
  fees_quote: number | null;
  spread_cost_quote: number | null;
  slippage_cost_quote: number | null;
  net_pnl_quote: number | null;
  net_return_pct: number | null;
  source_candles: Array<{ openTimeMs: number; closeTimeMs: number; open: number; high: number; low: number; close: number }>;
}

export interface PaperStrategyMetrics {
  strategy: string;
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

export interface PaperEvaluationReport {
  evaluation_version: string;
  policy_version: string;
  cost_model_version: string;
  minimum_training_trades: number;
  minimum_evidence_trades: number;
  closed_trade_count: number;
  pending_trade_count: number;
  skipped_trade_count: number;
  unpriceable_trade_count: number;
  folds: Array<{ month_utc: string; training_trades_available: number; status: "warmup" | "out_of_sample"; strategies: PaperStrategyMetrics[] }>;
  out_of_sample_strategies: PaperStrategyMetrics[];
  methodology_notes: string[];
}

