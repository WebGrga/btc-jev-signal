import type { MarketState } from "./types.js";

export type Horizon = "15m" | "1h" | "4h" | "eod";
export type Direction = "higher" | "lower";
export type ActualDirection = Direction | "unchanged";
export type Timeframe = "15m" | "1h" | "4h";

export interface TimeframeFeatures {
  interval: Timeframe;
  calculated_through_utc: string;
  completed_candles_used: number;
  last_close_usdt: number;
  anchor_distance_from_last_close_pct: number;
  completed_bar_return_pct: number;
  completed_4_bar_return_pct: number;
  rsi_14: number;
  macd_12_26_9: {
    line: number;
    signal: number;
    histogram: number;
  };
  atr_14_usdt: number;
  atr_14_pct: number;
  moving_averages_usdt: {
    sma_20: number;
    sma_50: number;
    sma_200: number;
    ema_20: number;
    ema_50: number;
    ema_200: number;
  };
  anchor_distance_from_moving_average_pct: {
    sma_20: number;
    sma_50: number;
    sma_200: number;
    ema_20: number;
    ema_50: number;
    ema_200: number;
  };
  volume: {
    last_completed_bar_base_btc: number;
    last_completed_bar_quote_usdt: number;
    mean_20_bar_base_btc: number;
    latest_to_mean_20_bar_ratio: number;
  };
}

export interface ExperimentState {
  schema_version: "2.0.0";
  snapshot: {
    timestamp_utc: string;
    collected_at_utc: string;
    collection_lag_ms: number;
    cadence: "scheduled_15m" | "manual_once";
    symbol: "BTCUSDT";
    quote_asset: "USDT";
    anchor_price_usdt: number;
    anchor_price_source: "Binance Spot completed 1m candle close";
  };
  targets: {
    "15m": string;
    "1h": string;
    "4h": string;
    end_of_utc_day: string;
  };
  returns_pct: {
    "1m": number;
    "5m": number;
    "15m": number;
    "1h": number;
    "4h": number;
  };
  timeframes: Record<Timeframe, TimeframeFeatures>;
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
  perpetual_futures: MarketState["perpetual_futures"];
  liquidations: MarketState["liquidations"];
  order_book: MarketState["order_book"];
  sources: {
    spot: "Binance Spot public market data";
    perpetual_futures: "Binance USD-M Futures public market data";
    liquidations: "Binance USD-M Futures public BTCUSDT liquidation WebSocket";
  };
}

export interface Forecast {
  forecast_id: string;
  horizon: Horizon;
  origin_timestamp_utc: string;
  target_timestamp_utc: string;
  origin_price_usdt: number;
  choice: Direction;
  confidence: number;
  probabilities: Record<Direction, number>;
  model: string;
  stage: "parallel_horizons" | "eod_cascade";
}

export interface PredictionBatch {
  batch_id: string;
  created_at_utc: string;
  experimental_only: true;
  state: ExperimentState;
  forecasts: Forecast[];
  usage: {
    parallel_horizons: unknown;
    eod_cascade: unknown;
  };
}

export interface Settlement {
  forecast_id: string;
  horizon: Horizon;
  origin_timestamp_utc: string;
  target_timestamp_utc: string;
  settled_at_utc: string;
  origin_price_usdt: number;
  target_price_usdt: number;
  actual_return_pct: number;
  predicted_direction: Direction;
  actual_direction: ActualDirection;
  correct: boolean | null;
  predicted_probability: number | null;
  brier_score: number | null;
  log_loss: number | null;
  target_price_source: "Binance Spot completed 1m candle close";
}

export interface HorizonReport {
  horizon: Horizon | "overall";
  issued: number;
  settled: number;
  pending: number;
  ties: number;
  scored: number;
  correct: number;
  accuracy: number | null;
  mean_brier_score: number | null;
  mean_log_loss: number | null;
  mean_chosen_probability: number | null;
}

export interface ExperimentReport {
  generated_at_utc: string;
  first_forecast_utc: string | null;
  last_forecast_utc: string | null;
  reports: HorizonReport[];
  note: string;
}
