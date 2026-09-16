import { buildMarketState } from "./binance.js";
import { atr, ema, macd, rsi, sma } from "./indicators.js";
import { fetchJson } from "./http.js";
import type { ExperimentState, Timeframe, TimeframeFeatures } from "./experiment-types.js";
import type { Candle } from "./types.js";

const SPOT_BASE = "https://data-api.binance.vision";
const SYMBOL = "BTCUSDT";
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const INTERVAL_MS = {
  "1m": MINUTE_MS,
  "15m": 15 * MINUTE_MS,
  "1h": 60 * MINUTE_MS,
  "4h": 240 * MINUTE_MS,
  "1d": DAY_MS,
} as const;

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

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function numeric(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric value for ${field}`);
  return parsed;
}

function parseKline(row: BinanceKline): Candle {
  return {
    openTimeMs: row[0],
    open: numeric(row[1], "kline.open"),
    high: numeric(row[2], "kline.high"),
    low: numeric(row[3], "kline.low"),
    close: numeric(row[4], "kline.close"),
    baseVolume: numeric(row[5], "kline.baseVolume"),
    closeTimeMs: row[6],
    quoteVolume: numeric(row[7], "kline.quoteVolume"),
    trades: row[8],
    takerBuyBaseVolume: numeric(row[9], "kline.takerBuyBaseVolume"),
    takerBuyQuoteVolume: numeric(row[10], "kline.takerBuyQuoteVolume"),
  };
}

function spotUrl(path: string, params: Record<string, string>): URL {
  const result = new URL(path, SPOT_BASE);
  for (const [key, value] of Object.entries(params)) result.searchParams.set(key, value);
  return result;
}

async function fetchCandles(
  interval: "1m" | "15m" | "1h" | "4h" | "1d",
  limit: number,
  endTimeMs: number,
): Promise<Candle[]> {
  const rows = await fetchJson<BinanceKline[]>(
    spotUrl("/api/v3/klines", {
      symbol: SYMBOL,
      interval,
      limit: String(limit),
      endTime: String(endTimeMs),
    }),
  );
  return rows.map(parseKline);
}

function candleFinalizationTimeoutMs(): number {
  const value = Number(process.env.CANDLE_FINALIZATION_TIMEOUT_MS ?? "60000");
  if (!Number.isInteger(value) || value < 5_000 || value > 180_000) {
    throw new Error("CANDLE_FINALIZATION_TIMEOUT_MS must be an integer between 5000 and 180000");
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function expectedCandleCloseMs(
  interval: keyof typeof INTERVAL_MS,
  boundaryMs: number,
): number {
  const duration = INTERVAL_MS[interval];
  return Math.floor(boundaryMs / duration) * duration - 1;
}

async function fetchFinalizedCandles(
  interval: "1m" | "15m" | "1h" | "4h",
  limit: number,
  boundaryMs: number,
): Promise<Candle[]> {
  const expectedClose = expectedCandleCloseMs(interval, boundaryMs);
  const deadline = Date.now() + candleFinalizationTimeoutMs();
  let latestClose: number | null = null;
  do {
    const candles = await fetchCandles(interval, limit, boundaryMs - 1);
    const completedCandles = candles.filter(
      (candle) => candle.closeTimeMs < boundaryMs,
    );
    latestClose = completedCandles.at(-1)?.closeTimeMs ?? null;
    if (latestClose === expectedClose) return candles;
    await delay(2_000);
  } while (Date.now() < deadline);

  throw new Error(
    `Timed out waiting for Binance ${interval} candle ending ${new Date(expectedClose).toISOString()}; latest completed close was ${latestClose === null ? "none" : new Date(latestClose).toISOString()}`,
  );
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function featureBlock(
  interval: Timeframe,
  rawCandles: readonly Candle[],
  boundaryMs: number,
  anchorPrice: number,
): TimeframeFeatures {
  const candles = rawCandles.filter((candle) => candle.closeTimeMs < boundaryMs);
  if (candles.length < 201) {
    throw new Error(`${interval} features require 201 completed candles; received ${candles.length}`);
  }
  const closes = candles.map((candle) => candle.close);
  const latest = candles.at(-1)!;
  const previous = candles.at(-2)!;
  const fourBarsAgo = candles.at(-5)!;
  const moving = {
    sma_20: sma(closes, 20),
    sma_50: sma(closes, 50),
    sma_200: sma(closes, 200),
    ema_20: ema(closes, 20),
    ema_50: ema(closes, 50),
    ema_200: ema(closes, 200),
  };
  const roundedMoving = Object.fromEntries(
    Object.entries(moving).map(([key, value]) => [key, round(value, 2)]),
  ) as TimeframeFeatures["moving_averages_usdt"];
  const distances = Object.fromEntries(
    Object.entries(moving).map(([key, value]) => [key, round((anchorPrice / value - 1) * 100)]),
  ) as TimeframeFeatures["anchor_distance_from_moving_average_pct"];
  const atrValue = atr(candles, 14);
  const macdValue = macd(closes);
  const last20 = candles.slice(-20);
  const mean20Volume = sum(last20.map((candle) => candle.baseVolume)) / last20.length;

  return {
    interval,
    calculated_through_utc: new Date(latest.closeTimeMs).toISOString(),
    completed_candles_used: candles.length,
    last_close_usdt: round(latest.close, 2),
    anchor_distance_from_last_close_pct: round((anchorPrice / latest.close - 1) * 100),
    completed_bar_return_pct: round((latest.close / previous.close - 1) * 100),
    completed_4_bar_return_pct: round((latest.close / fourBarsAgo.close - 1) * 100),
    rsi_14: round(rsi(closes, 14)),
    macd_12_26_9: {
      line: round(macdValue.line),
      signal: round(macdValue.signal),
      histogram: round(macdValue.histogram),
    },
    atr_14_usdt: round(atrValue, 2),
    atr_14_pct: round((atrValue / latest.close) * 100),
    moving_averages_usdt: roundedMoving,
    anchor_distance_from_moving_average_pct: distances,
    volume: {
      last_completed_bar_base_btc: round(latest.baseVolume),
      last_completed_bar_quote_usdt: round(latest.quoteVolume, 2),
      mean_20_bar_base_btc: round(mean20Volume),
      latest_to_mean_20_bar_ratio:
        mean20Volume === 0 ? 0 : round(latest.baseVolume / mean20Volume),
    },
  };
}

function referenceClose(candles: readonly Candle[], targetMs: number): Candle {
  const result = [...candles].reverse().find((candle) => candle.closeTimeMs <= targetMs - 1);
  if (!result) throw new Error(`No 1m reference close for ${new Date(targetMs).toISOString()}`);
  return result;
}

function nextUtcMidnight(milliseconds: number): number {
  const date = new Date(milliseconds);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export async function fetchAlignedClose(timestampMs: number): Promise<number> {
  const candles = await fetchFinalizedCandles("1m", 2, timestampMs);
  const candle = referenceClose(candles, timestampMs);
  if (candle.closeTimeMs !== timestampMs - 1) {
    throw new Error(
      `Expected a 1m candle ending ${new Date(timestampMs - 1).toISOString()}, received ${new Date(candle.closeTimeMs).toISOString()}`,
    );
  }
  return round(candle.close, 2);
}

export async function buildExperimentState(
  boundaryMs: number,
  cadence: ExperimentState["snapshot"]["cadence"],
  liquidationWindowMs: number,
): Promise<ExperimentState> {
  if (boundaryMs % MINUTE_MS !== 0) throw new Error("Experiment boundary must align to a UTC minute");
  const endTimeMs = boundaryMs - 1;
  const [auxiliary, oneMinute, fifteenMinute, oneHour, fourHour, dayRows] = await Promise.all([
    buildMarketState(liquidationWindowMs),
    fetchFinalizedCandles("1m", 500, boundaryMs),
    fetchFinalizedCandles("15m", 500, boundaryMs),
    fetchFinalizedCandles("1h", 500, boundaryMs),
    fetchFinalizedCandles("4h", 500, boundaryMs),
    fetchCandles("1d", 2, endTimeMs),
  ]);
  const completedOneMinute = oneMinute.filter((candle) => candle.closeTimeMs < boundaryMs);
  const anchorCandle = completedOneMinute.at(-1);
  if (!anchorCandle || anchorCandle.closeTimeMs !== boundaryMs - 1) {
    throw new Error("The exact boundary-aligned BTCUSDT 1m close is unavailable");
  }
  const anchorPrice = anchorCandle.close;
  const returnMinutes = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240 } as const;
  const returns = {} as ExperimentState["returns_pct"];
  for (const [label, minutes] of Object.entries(returnMinutes) as [keyof typeof returnMinutes, number][]) {
    const reference = referenceClose(completedOneMinute, boundaryMs - minutes * MINUTE_MS);
    returns[label] = round((anchorPrice / reference.close - 1) * 100);
  }

  const dayStartMs = Math.floor(boundaryMs / DAY_MS) * DAY_MS;
  const dayEndMs = nextUtcMidnight(boundaryMs);
  const dayCandle = boundaryMs === dayStartMs
    ? null
    : [...dayRows].reverse().find((candle) => candle.openTimeMs === dayStartMs) ?? null;
  const dayOpen = dayCandle?.open ?? anchorPrice;
  const collectedAtMs = Date.now();

  return {
    schema_version: "2.0.0",
    snapshot: {
      timestamp_utc: new Date(boundaryMs).toISOString(),
      collected_at_utc: new Date(collectedAtMs).toISOString(),
      collection_lag_ms: collectedAtMs - boundaryMs,
      cadence,
      symbol: SYMBOL,
      quote_asset: "USDT",
      anchor_price_usdt: round(anchorPrice, 2),
      anchor_price_source: "Binance Spot completed 1m candle close",
    },
    targets: {
      "15m": new Date(boundaryMs + 15 * MINUTE_MS).toISOString(),
      "1h": new Date(boundaryMs + 60 * MINUTE_MS).toISOString(),
      "4h": new Date(boundaryMs + 240 * MINUTE_MS).toISOString(),
      end_of_utc_day: new Date(dayEndMs).toISOString(),
    },
    returns_pct: returns,
    timeframes: {
      "15m": featureBlock("15m", fifteenMinute, boundaryMs, anchorPrice),
      "1h": featureBlock("1h", oneHour, boundaryMs, anchorPrice),
      "4h": featureBlock("4h", fourHour, boundaryMs, anchorPrice),
    },
    utc_session: {
      day_start_utc: new Date(dayStartMs).toISOString(),
      day_end_utc: new Date(dayEndMs).toISOString(),
      minutes_until_day_end: (dayEndMs - boundaryMs) / MINUTE_MS,
      open_usdt: round(dayOpen, 2),
      high_usdt: round(dayCandle?.high ?? anchorPrice, 2),
      low_usdt: round(dayCandle?.low ?? anchorPrice, 2),
      return_from_open_pct: round((anchorPrice / dayOpen - 1) * 100),
      base_volume_btc: round(dayCandle?.baseVolume ?? 0),
      quote_volume_usdt: round(dayCandle?.quoteVolume ?? 0, 2),
    },
    perpetual_futures: auxiliary.perpetual_futures,
    liquidations: auxiliary.liquidations,
    order_book: auxiliary.order_book,
    sources: auxiliary.sources,
  };
}
