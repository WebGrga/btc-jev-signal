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
  rsi_14: number;
  atr_14_pct: number;
  completed_bar_return_pct: number;
  completed_4_bar_return_pct: number;
  calculated_through_utc: string;
}

export interface ExperimentState {
  snapshot: {
    timestamp_utc: string;
    anchor_price_usdt: number;
    collection_lag_ms: number;
  };
  returns_pct: Record<"1m" | "5m" | "15m" | "1h" | "4h", number>;
  timeframes: Record<"15m" | "1h" | "4h", TimeframeFeatures>;
  utc_session: {
    minutes_until_day_end: number;
    return_from_open_pct: number;
  };
  perpetual_futures: {
    available: boolean;
    last_funding_rate: number | null;
    open_interest_btc: number | null;
    open_interest_change_pct: Record<"5m" | "15m" | "1h", number> | null;
  };
  liquidations: {
    available: boolean;
    event_count: number;
    long_liquidation_notional_usdt: number;
    short_liquidation_notional_usdt: number;
  };
  order_book: {
    available: boolean;
    imbalance: number | null;
    spread_bps: number | null;
  };
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
    higher_probability: Record<Horizon, number>;
  }>;
  report: {
    generated_at_utc: string;
    first_forecast_utc: string | null;
    last_forecast_utc: string | null;
    reports: HorizonReport[];
    note: string;
  };
}
