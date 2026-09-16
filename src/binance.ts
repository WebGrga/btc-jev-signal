import WebSocket from "ws";
import { atr, ema, macd, rsi, sma } from "./indicators.js";
import { fetchJson, safeErrorMessage } from "./http.js";
import type { Candle, MarketState } from "./types.js";

const SPOT_BASE = "https://data-api.binance.vision";
const FUTURES_BASE = "https://fapi.binance.com";
const SYMBOL = "BTCUSDT";
const MINUTE_MS = 60_000;

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

interface PremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
}

interface OpenInterest {
  symbol: string;
  openInterest: string;
  time: number;
}

interface OpenInterestHistory {
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

interface Depth {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

interface ForceOrderEvent {
  e: "forceOrder";
  E: number;
  o: {
    s: string;
    S: "BUY" | "SELL";
    q: string;
    z?: string;
    p: string;
    ap: string;
    T: number;
  };
}

function url(base: string, path: string, params: Record<string, string>): URL {
  const result = new URL(path, base);
  for (const [key, value] of Object.entries(params)) result.searchParams.set(key, value);
  return result;
}

function number(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric value for ${field}`);
  return parsed;
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function parseKline(row: BinanceKline): Candle {
  return {
    openTimeMs: row[0],
    open: number(row[1], "kline.open"),
    high: number(row[2], "kline.high"),
    low: number(row[3], "kline.low"),
    close: number(row[4], "kline.close"),
    baseVolume: number(row[5], "kline.volume"),
    closeTimeMs: row[6],
    quoteVolume: number(row[7], "kline.quoteVolume"),
    trades: row[8],
    takerBuyBaseVolume: number(row[9], "kline.takerBuyBaseVolume"),
    takerBuyQuoteVolume: number(row[10], "kline.takerBuyQuoteVolume"),
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function referenceCandle(candles: readonly Candle[], targetMs: number): Candle {
  const candle = [...candles].reverse().find((candidate) => candidate.closeTimeMs <= targetMs);
  if (!candle) throw new Error(`No completed candle found at or before ${iso(targetMs)}`);
  return candle;
}

function oiChange(history: readonly OpenInterestHistory[], periodsAgo: number): number | null {
  if (history.length <= periodsAgo) return null;
  const current = number(history.at(-1)!.sumOpenInterest, "openInterestHistory.current");
  const previous = number(history.at(-(periodsAgo + 1))!.sumOpenInterest, "openInterestHistory.previous");
  return previous === 0 ? null : round((current / previous - 1) * 100);
}

async function fetchDerivatives(): Promise<MarketState["perpetual_futures"]> {
  try {
    const [premium, openInterest, history] = await Promise.all([
      fetchJson<PremiumIndex>(url(FUTURES_BASE, "/fapi/v1/premiumIndex", { symbol: SYMBOL })),
      fetchJson<OpenInterest>(url(FUTURES_BASE, "/fapi/v1/openInterest", { symbol: SYMBOL })),
      fetchJson<OpenInterestHistory[]>(
        url(FUTURES_BASE, "/futures/data/openInterestHist", {
          symbol: SYMBOL,
          period: "5m",
          limit: "13",
        }),
      ),
    ]);
    const markPrice = number(premium.markPrice, "markPrice");
    const oi = number(openInterest.openInterest, "openInterest");
    return {
      available: true,
      mark_price_usdt: round(markPrice, 2),
      index_price_usdt: round(number(premium.indexPrice, "indexPrice"), 2),
      last_funding_rate: round(number(premium.lastFundingRate, "lastFundingRate"), 8),
      funding_interval_hours: 8,
      next_funding_time_utc: iso(premium.nextFundingTime),
      open_interest_btc: round(oi, 3),
      open_interest_notional_usdt: round(oi * markPrice, 2),
      open_interest_as_of_utc: iso(openInterest.time),
      open_interest_change_pct: {
        "5m": oiChange(history, 1),
        "15m": oiChange(history, 3),
        "1h": oiChange(history, 12),
      },
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      mark_price_usdt: null,
      index_price_usdt: null,
      last_funding_rate: null,
      funding_interval_hours: 8,
      next_funding_time_utc: null,
      open_interest_btc: null,
      open_interest_notional_usdt: null,
      open_interest_as_of_utc: null,
      open_interest_change_pct: { "5m": null, "15m": null, "1h": null },
      error: safeErrorMessage(error),
    };
  }
}

async function fetchOrderBook(): Promise<MarketState["order_book"]> {
  const asOf = Date.now();
  try {
    const depth = await fetchJson<Depth>(
      url(SPOT_BASE, "/api/v3/depth", { symbol: SYMBOL, limit: "20" }),
    );
    const bids = depth.bids.map(([price, quantity]) => [number(price, "bid.price"), number(quantity, "bid.quantity")] as const);
    const asks = depth.asks.map(([price, quantity]) => [number(price, "ask.price"), number(quantity, "ask.quantity")] as const);
    const bestBid = bids[0]?.[0];
    const bestAsk = asks[0]?.[0];
    if (bestBid === undefined || bestAsk === undefined) throw new Error("Order book contained no levels");
    const bidNotional = sum(bids.map(([price, quantity]) => price * quantity));
    const askNotional = sum(asks.map(([price, quantity]) => price * quantity));
    const totalNotional = bidNotional + askNotional;
    return {
      available: true,
      as_of_utc: iso(asOf),
      depth_levels: 20,
      best_bid_usdt: round(bestBid, 2),
      best_ask_usdt: round(bestAsk, 2),
      spread_bps: round(((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10_000),
      bid_notional_usdt: round(bidNotional, 2),
      ask_notional_usdt: round(askNotional, 2),
      imbalance: totalNotional === 0 ? null : round((bidNotional - askNotional) / totalNotional),
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      as_of_utc: iso(asOf),
      depth_levels: 20,
      best_bid_usdt: null,
      best_ask_usdt: null,
      spread_bps: null,
      bid_notional_usdt: null,
      ask_notional_usdt: null,
      imbalance: null,
      error: safeErrorMessage(error),
    };
  }
}

export async function observeLiquidations(windowMs: number): Promise<MarketState["liquidations"]> {
  const startMs = Date.now();
  let longNotional = 0;
  let shortNotional = 0;
  let eventCount = 0;
  let available = false;
  let errorMessage: string | null = null;

  if (windowMs <= 0) {
    return {
      available: false,
      observation_start_utc: iso(startMs),
      observation_end_utc: iso(startMs),
      observation_window_ms: 0,
      event_count: 0,
      long_liquidation_notional_usdt: 0,
      short_liquidation_notional_usdt: 0,
      total_liquidation_notional_usdt: 0,
      error: "Observation disabled by LIQUIDATION_WINDOW_MS=0",
    };
  }

  await new Promise<void>((resolve) => {
    const socket = new WebSocket("wss://fstream.binance.com/ws/btcusdt@forceOrder");
    const timer = setTimeout(() => {
      socket.close();
      resolve();
    }, windowMs);

    socket.on("open", () => {
      available = true;
    });
    socket.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString()) as ForceOrderEvent;
        if (event.e !== "forceOrder" || event.o.s !== SYMBOL) return;
        const price = number(event.o.ap === "0" ? event.o.p : event.o.ap, "liquidation.price");
        const executedQuantity = number(event.o.z ?? event.o.q, "liquidation.executedQuantity");
        const notional = executedQuantity * price;
        eventCount += 1;
        if (event.o.S === "SELL") longNotional += notional;
        else shortNotional += notional;
      } catch (error) {
        errorMessage = safeErrorMessage(error);
      }
    });
    socket.on("error", (error) => {
      errorMessage = safeErrorMessage(error);
      clearTimeout(timer);
      resolve();
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const endMs = Date.now();
  return {
    available,
    observation_start_utc: iso(startMs),
    observation_end_utc: iso(endMs),
    observation_window_ms: endMs - startMs,
    event_count: eventCount,
    long_liquidation_notional_usdt: round(longNotional, 2),
    short_liquidation_notional_usdt: round(shortNotional, 2),
    total_liquidation_notional_usdt: round(longNotional + shortNotional, 2),
    error: errorMessage,
  };
}

export async function buildMarketState(liquidationWindowMs: number): Promise<MarketState> {
  const [rawKlines, derivatives, orderBook, liquidations] = await Promise.all([
    fetchJson<BinanceKline[]>(
      url(SPOT_BASE, "/api/v3/klines", { symbol: SYMBOL, interval: "1m", limit: "500" }),
    ),
    fetchDerivatives(),
    fetchOrderBook(),
    observeLiquidations(liquidationWindowMs),
  ]);
  // Fetch the reference price last so the snapshot and 60-minute target are
  // anchored after the longer liquidation observation window has completed.
  const ticker = await fetchJson<{ symbol: string; price: string }>(
    url(SPOT_BASE, "/api/v3/ticker/price", { symbol: SYMBOL }),
  );
  const snapshotMs = Date.now();

  const spotPrice = number(ticker.price, "ticker.price");
  const candles = rawKlines.map(parseKline);
  const completed = candles.filter((candle) => candle.closeTimeMs < snapshotMs);
  if (completed.length < 201) throw new Error(`Expected at least 201 completed candles; received ${completed.length}`);
  const closes = completed.map((candle) => candle.close);
  const lastCandle = completed.at(-1)!;
  const horizons = { "1m": 1, "5m": 5, "15m": 15, "1h": 60 } as const;
  const returnValues = {} as MarketState["spot"]["returns_pct"];
  const referenceTimes = {} as MarketState["spot"]["return_reference_close_utc"];
  for (const [key, minutes] of Object.entries(horizons) as [keyof typeof horizons, number][]) {
    const reference = referenceCandle(completed, snapshotMs - minutes * MINUTE_MS);
    returnValues[key] = round((spotPrice / reference.close - 1) * 100);
    referenceTimes[key] = iso(reference.closeTimeMs);
  }

  const movingAverages = {
    sma_20: sma(closes, 20),
    sma_50: sma(closes, 50),
    sma_200: sma(closes, 200),
    ema_20: ema(closes, 20),
    ema_50: ema(closes, 50),
    ema_200: ema(closes, 200),
  };
  const roundedMovingAverages = Object.fromEntries(
    Object.entries(movingAverages).map(([key, value]) => [key, round(value, 2)]),
  ) as MarketState["indicators_1m"]["moving_averages_usdt"];
  const distances = Object.fromEntries(
    Object.entries(movingAverages).map(([key, value]) => [key, round((spotPrice / value - 1) * 100)]),
  ) as MarketState["indicators_1m"]["distance_from_moving_average_pct"];
  const atrValue = atr(completed, 14);
  const macdValue = macd(closes);
  const last20 = completed.slice(-20);
  const last60 = completed.slice(-60);
  const mean20Volume = sum(last20.map((candle) => candle.baseVolume)) / last20.length;

  return {
    schema_version: "1.0.0",
    snapshot: {
      timestamp_utc: iso(snapshotMs),
      target_timestamp_utc: iso(snapshotMs + 60 * MINUTE_MS),
      horizon_minutes: 60,
      symbol: SYMBOL,
      quote_asset: "USDT",
    },
    sources: {
      spot: "Binance Spot public market data",
      perpetual_futures: "Binance USD-M Futures public market data",
      liquidations: "Binance USD-M Futures public BTCUSDT liquidation WebSocket",
    },
    spot: {
      price_usdt: round(spotPrice, 2),
      price_as_of_utc: iso(snapshotMs),
      returns_pct: returnValues,
      return_reference_close_utc: referenceTimes,
    },
    indicators_1m: {
      calculated_through_utc: iso(lastCandle.closeTimeMs),
      rsi_14: round(rsi(closes, 14)),
      macd_12_26_9: {
        line: round(macdValue.line),
        signal: round(macdValue.signal),
        histogram: round(macdValue.histogram),
      },
      atr_14_usdt: round(atrValue, 2),
      atr_14_pct: round((atrValue / lastCandle.close) * 100),
      moving_averages_usdt: roundedMovingAverages,
      distance_from_moving_average_pct: distances,
    },
    volume: {
      last_completed_1m_base_btc: round(lastCandle.baseVolume),
      last_completed_1m_quote_usdt: round(lastCandle.quoteVolume, 2),
      trailing_60m_base_btc: round(sum(last60.map((candle) => candle.baseVolume))),
      trailing_60m_quote_usdt: round(sum(last60.map((candle) => candle.quoteVolume)), 2),
      mean_20m_base_btc: round(mean20Volume),
      latest_to_mean_20m_ratio: mean20Volume === 0 ? 0 : round(lastCandle.baseVolume / mean20Volume),
    },
    perpetual_futures: derivatives,
    liquidations,
    order_book: orderBook,
  };
}
