export interface Candle {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  baseVolume: number;
  closeTimeMs: number;
  quoteVolume: number;
  trades: number;
  takerBuyBaseVolume: number;
  takerBuyQuoteVolume: number;
}

export interface NullableMetric<T> {
  available: boolean;
  value: T | null;
  error: string | null;
}

export interface MarketState {
  schema_version: "1.0.0";
  snapshot: {
    timestamp_utc: string;
    target_timestamp_utc: string;
    horizon_minutes: 60;
    symbol: "BTCUSDT";
    quote_asset: "USDT";
  };
  sources: {
    spot: "Binance Spot public market data";
    perpetual_futures: "Binance USD-M Futures public market data";
    liquidations: "Binance USD-M Futures public BTCUSDT liquidation WebSocket";
  };
  spot: {
    price_usdt: number;
    price_as_of_utc: string;
    returns_pct: {
      "1m": number;
      "5m": number;
      "15m": number;
      "1h": number;
    };
    return_reference_close_utc: {
      "1m": string;
      "5m": string;
      "15m": string;
      "1h": string;
    };
  };
  indicators_1m: {
    calculated_through_utc: string;
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
    distance_from_moving_average_pct: {
      sma_20: number;
      sma_50: number;
      sma_200: number;
      ema_20: number;
      ema_50: number;
      ema_200: number;
    };
  };
  volume: {
    last_completed_1m_base_btc: number;
    last_completed_1m_quote_usdt: number;
    trailing_60m_base_btc: number;
    trailing_60m_quote_usdt: number;
    mean_20m_base_btc: number;
    latest_to_mean_20m_ratio: number;
  };
  perpetual_futures: {
    available: boolean;
    mark_price_usdt: number | null;
    index_price_usdt: number | null;
    last_funding_rate: number | null;
    funding_interval_hours: 8;
    next_funding_time_utc: string | null;
    open_interest_btc: number | null;
    open_interest_notional_usdt: number | null;
    open_interest_as_of_utc: string | null;
    open_interest_change_pct: {
      "5m": number | null;
      "15m": number | null;
      "1h": number | null;
    };
    error: string | null;
  };
  liquidations: {
    available: boolean;
    observation_start_utc: string;
    observation_end_utc: string;
    observation_window_ms: number;
    event_count: number;
    long_liquidation_notional_usdt: number;
    short_liquidation_notional_usdt: number;
    total_liquidation_notional_usdt: number;
    error: string | null;
  };
  order_book: {
    available: boolean;
    as_of_utc: string;
    depth_levels: 20;
    best_bid_usdt: number | null;
    best_ask_usdt: number | null;
    spread_bps: number | null;
    bid_notional_usdt: number | null;
    ask_notional_usdt: number | null;
    imbalance: number | null;
    error: string | null;
  };
}

export interface DirectionPrediction {
  model: string;
  question: {
    id: "btc_spot_direction_60m";
    horizon_minutes: 60;
    target_timestamp_utc: string;
  };
  answer: {
    choice: "higher" | "lower" | "unchanged";
    confidence: number;
    probabilities: Record<"higher" | "lower" | "unchanged", number>;
  };
  usage: unknown;
}

export interface PredictionOutput {
  generated_at_utc: string;
  experimental_only: true;
  state: MarketState;
  jev: DirectionPrediction;
}
