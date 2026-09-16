import { atr, ema, macd, rsi, sma } from "./indicators.js";
import type { ExperimentState, Timeframe, TimeframeFeatures } from "./experiment-types.js";
import type { Candle, MarketState } from "./types.js";

const MARKET_BASE = "https://api.bybit.com";
const SYMBOL = "BTCUSDT";
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const FINALIZATION_TIMEOUT_MS = 60_000;
const INTERVAL_MS = { "1m": MINUTE_MS, "15m": 15 * MINUTE_MS, "1h": 60 * MINUTE_MS, "4h": 240 * MINUTE_MS, "1d": DAY_MS } as const;

type BybitKline = [string, string, string, string, string, string, string];
interface BybitResponse<T> { retCode: number; retMsg: string; result: T; time: number }
interface KlineResult { list: BybitKline[] }
interface TickerResult { list: Array<{ markPrice: string; indexPrice: string; fundingRate: string; nextFundingTime: string; openInterest: string }> }
interface OpenInterestHistory { openInterest: string; timestamp: string }
interface OpenInterestResult { list: OpenInterestHistory[] }
interface DepthResult { b: [string, string][]; a: [string, string][]; ts: number }
interface LiquidationEvent { topic: string; data?: Array<{ T: number; s: string; S: "Buy" | "Sell"; v: string; p: string }> }

function round(value: number, digits = 6): number { return Number(value.toFixed(digits)); }
function numeric(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric value for ${field}`);
  return parsed;
}
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function iso(milliseconds: number): string { return new Date(milliseconds).toISOString(); }
function url(base: string, path: string, params: Record<string, string>): URL {
  const result = new URL(path, base);
  for (const [key, value] of Object.entries(params)) result.searchParams.set(key, value);
  return result;
}

async function fetchJson<T>(input: URL, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(input, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`${input.host}${input.pathname} returned ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 5_000)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchBybitJson<T>(input: URL): Promise<T> {
  const response = await fetchJson<BybitResponse<T>>(input);
  if (response.retCode !== 0) throw new Error(`Bybit API returned ${response.retCode}: ${response.retMsg}`);
  return response.result;
}

function bybitInterval(interval: keyof typeof INTERVAL_MS): string {
  return interval === "1m" ? "1" : interval === "15m" ? "15" : interval === "1h" ? "60" : interval === "4h" ? "240" : "D";
}

function parseKline(row: BybitKline, interval: keyof typeof INTERVAL_MS): Candle {
  const openTimeMs = Number(row[0]);
  return {
    openTimeMs, open: numeric(row[1], "open"), high: numeric(row[2], "high"), low: numeric(row[3], "low"),
    close: numeric(row[4], "close"), baseVolume: numeric(row[5], "baseVolume"), closeTimeMs: openTimeMs + INTERVAL_MS[interval] - 1,
    quoteVolume: numeric(row[6], "quoteVolume"), trades: 0, takerBuyBaseVolume: 0, takerBuyQuoteVolume: 0,
  };
}

async function fetchCandles(interval: keyof typeof INTERVAL_MS, limit: number, endTimeMs: number): Promise<Candle[]> {
  const response = await fetchBybitJson<KlineResult>(
    url(MARKET_BASE, "/v5/market/kline", {
      category: "spot",
      symbol: SYMBOL,
      interval: bybitInterval(interval),
      limit: String(limit),
      end: String(endTimeMs),
    }),
  );
  return response.list.map((row) => parseKline(row, interval)).sort((left, right) => left.openTimeMs - right.openTimeMs);
}

function expectedCandleCloseMs(interval: keyof typeof INTERVAL_MS, boundaryMs: number): number {
  const duration = INTERVAL_MS[interval];
  return Math.floor(boundaryMs / duration) * duration - 1;
}

async function fetchFinalizedCandles(interval: "1m" | "15m" | "1h" | "4h", limit: number, boundaryMs: number): Promise<Candle[]> {
  const expectedClose = expectedCandleCloseMs(interval, boundaryMs);
  const deadline = Date.now() + FINALIZATION_TIMEOUT_MS;
  let latestClose: number | null = null;
  do {
    const candles = await fetchCandles(interval, limit, boundaryMs - 1);
    const completed = candles.filter((candle) => candle.closeTimeMs < boundaryMs);
    latestClose = completed.at(-1)?.closeTimeMs ?? null;
    if (latestClose === expectedClose) return candles;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for Bybit Spot ${interval} candle ending ${iso(expectedClose)}; latest was ${latestClose === null ? "none" : iso(latestClose)}`);
}

function referenceClose(candles: readonly Candle[], targetMs: number): Candle {
  const result = [...candles].reverse().find((candle) => candle.closeTimeMs <= targetMs - 1);
  if (!result) throw new Error(`No 1m reference close for ${iso(targetMs)}`);
  return result;
}

function featureBlock(interval: Timeframe, rawCandles: readonly Candle[], boundaryMs: number, anchorPrice: number): TimeframeFeatures {
  const candles = rawCandles.filter((candle) => candle.closeTimeMs < boundaryMs);
  if (candles.length < 201) throw new Error(`${interval} features require 201 completed candles; received ${candles.length}`);
  const closes = candles.map((candle) => candle.close);
  const latest = candles.at(-1)!;
  const moving = { sma_20: sma(closes, 20), sma_50: sma(closes, 50), sma_200: sma(closes, 200), ema_20: ema(closes, 20), ema_50: ema(closes, 50), ema_200: ema(closes, 200) };
  const roundedMoving = Object.fromEntries(Object.entries(moving).map(([key, value]) => [key, round(value, 2)])) as TimeframeFeatures["moving_averages_usdt"];
  const distances = Object.fromEntries(Object.entries(moving).map(([key, value]) => [key, round((anchorPrice / value - 1) * 100)])) as TimeframeFeatures["anchor_distance_from_moving_average_pct"];
  const atrValue = atr(candles, 14);
  const macdValue = macd(closes);
  const last20 = candles.slice(-20);
  const mean20Volume = sum(last20.map((candle) => candle.baseVolume)) / last20.length;
  return {
    interval, calculated_through_utc: iso(latest.closeTimeMs), completed_candles_used: candles.length, last_close_usdt: round(latest.close, 2),
    anchor_distance_from_last_close_pct: round((anchorPrice / latest.close - 1) * 100),
    completed_bar_return_pct: round((latest.close / candles.at(-2)!.close - 1) * 100),
    completed_4_bar_return_pct: round((latest.close / candles.at(-5)!.close - 1) * 100), rsi_14: round(rsi(closes, 14)),
    macd_12_26_9: { line: round(macdValue.line), signal: round(macdValue.signal), histogram: round(macdValue.histogram) },
    atr_14_usdt: round(atrValue, 2), atr_14_pct: round((atrValue / latest.close) * 100), moving_averages_usdt: roundedMoving,
    anchor_distance_from_moving_average_pct: distances,
    volume: { last_completed_bar_base_btc: round(latest.baseVolume), last_completed_bar_quote_usdt: round(latest.quoteVolume, 2), mean_20_bar_base_btc: round(mean20Volume), latest_to_mean_20_bar_ratio: mean20Volume === 0 ? 0 : round(latest.baseVolume / mean20Volume) },
  };
}

function oiChange(history: readonly OpenInterestHistory[], periodsAgo: number): number | null {
  if (history.length <= periodsAgo) return null;
  const current = numeric(history.at(-1)!.openInterest, "openInterest.current");
  const previous = numeric(history.at(-(periodsAgo + 1))!.openInterest, "openInterest.previous");
  return previous === 0 ? null : round((current / previous - 1) * 100);
}

async function fetchDerivatives(): Promise<MarketState["perpetual_futures"]> {
  try {
    const [tickerResult, historyResult] = await Promise.all([
      fetchBybitJson<TickerResult>(url(MARKET_BASE, "/v5/market/tickers", { category: "linear", symbol: SYMBOL })),
      fetchBybitJson<OpenInterestResult>(url(MARKET_BASE, "/v5/market/open-interest", { category: "linear", symbol: SYMBOL, intervalTime: "5min", limit: "13" })),
    ]);
    const ticker = tickerResult.list[0];
    if (!ticker) throw new Error("Bybit ticker response contained no BTCUSDT market");
    const history = [...historyResult.list].sort((left, right) => Number(left.timestamp) - Number(right.timestamp));
    const mark = numeric(ticker.markPrice, "markPrice");
    const oi = numeric(ticker.openInterest, "openInterest");
    return { available: true, mark_price_usdt: round(mark, 2), index_price_usdt: round(numeric(ticker.indexPrice, "indexPrice"), 2), last_funding_rate: round(numeric(ticker.fundingRate, "funding"), 8), funding_interval_hours: 8, next_funding_time_utc: iso(Number(ticker.nextFundingTime)), open_interest_btc: round(oi, 3), open_interest_notional_usdt: round(oi * mark, 2), open_interest_as_of_utc: history.at(-1) ? iso(Number(history.at(-1)!.timestamp)) : iso(Date.now()), open_interest_change_pct: { "5m": oiChange(history, 1), "15m": oiChange(history, 3), "1h": oiChange(history, 12) }, error: null };
  } catch (error) {
    return { available: false, mark_price_usdt: null, index_price_usdt: null, last_funding_rate: null, funding_interval_hours: 8, next_funding_time_utc: null, open_interest_btc: null, open_interest_notional_usdt: null, open_interest_as_of_utc: null, open_interest_change_pct: { "5m": null, "15m": null, "1h": null }, error: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchOrderBook(): Promise<MarketState["order_book"]> {
  const asOf = Date.now();
  try {
    const depth = await fetchBybitJson<DepthResult>(
      url(MARKET_BASE, "/v5/market/orderbook", { category: "spot", symbol: SYMBOL, limit: "20" }),
    );
    const bids = depth.b.map(([price, quantity]) => [numeric(price, "bid.price"), numeric(quantity, "bid.quantity")] as const);
    const asks = depth.a.map(([price, quantity]) => [numeric(price, "ask.price"), numeric(quantity, "ask.quantity")] as const);
    const bestBid = bids[0]?.[0]; const bestAsk = asks[0]?.[0];
    if (bestBid === undefined || bestAsk === undefined) throw new Error("Order book contained no levels");
    const bidNotional = sum(bids.map(([price, quantity]) => price * quantity));
    const askNotional = sum(asks.map(([price, quantity]) => price * quantity));
    return { available: true, as_of_utc: iso(asOf), depth_levels: 20, best_bid_usdt: round(bestBid, 2), best_ask_usdt: round(bestAsk, 2), spread_bps: round(((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10_000), bid_notional_usdt: round(bidNotional, 2), ask_notional_usdt: round(askNotional, 2), imbalance: bidNotional + askNotional === 0 ? null : round((bidNotional - askNotional) / (bidNotional + askNotional)), error: null };
  } catch (error) {
    return { available: false, as_of_utc: iso(asOf), depth_levels: 20, best_bid_usdt: null, best_ask_usdt: null, spread_bps: null, bid_notional_usdt: null, ask_notional_usdt: null, imbalance: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function observeLiquidations(windowMs: number): Promise<MarketState["liquidations"]> {
  const start = Date.now(); let long = 0; let short = 0; let count = 0; let available = false; let failure: string | null = null;
  if (windowMs <= 0) return { available: false, observation_start_utc: iso(start), observation_end_utc: iso(start), observation_window_ms: 0, event_count: 0, long_liquidation_notional_usdt: 0, short_liquidation_notional_usdt: 0, total_liquidation_notional_usdt: 0, error: "Observation disabled" };
  await new Promise<void>((resolve) => {
    const socket = new WebSocket("wss://stream.bybit.com/v5/public/linear");
    let finished = false;
    const finish = () => { if (finished) return; finished = true; try { socket.close(1000, "window complete"); } catch { /* already closed */ } resolve(); };
    const timer = setTimeout(finish, windowMs);
    socket.addEventListener("open", () => {
      available = true;
      socket.send(JSON.stringify({ op: "subscribe", args: [`allLiquidation.${SYMBOL}`] }));
    });
    socket.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as LiquidationEvent;
        if (parsed.topic !== `allLiquidation.${SYMBOL}` || !parsed.data) return;
        for (const liquidation of parsed.data) {
          if (liquidation.s !== SYMBOL) continue;
          const price = numeric(liquidation.p, "liquidation.price");
          const quantity = numeric(liquidation.v, "liquidation.quantity");
          count += 1;
          if (liquidation.S === "Sell") long += price * quantity; else short += price * quantity;
        }
      } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    });
    socket.addEventListener("error", () => { failure = "Liquidation WebSocket failed"; clearTimeout(timer); finish(); });
    socket.addEventListener("close", () => { clearTimeout(timer); if (!finished) { finished = true; resolve(); } });
  });
  const end = Date.now();
  return { available, observation_start_utc: iso(start), observation_end_utc: iso(end), observation_window_ms: end - start, event_count: count, long_liquidation_notional_usdt: round(long, 2), short_liquidation_notional_usdt: round(short, 2), total_liquidation_notional_usdt: round(long + short, 2), error: failure };
}

async function buildAuxiliary(liquidationWindowMs: number): Promise<Pick<ExperimentState, "perpetual_futures" | "liquidations" | "order_book" | "sources">> {
  const [perpetualFutures, liquidations, orderBook] = await Promise.all([fetchDerivatives(), observeLiquidations(liquidationWindowMs), fetchOrderBook()]);
  return { perpetual_futures: perpetualFutures, liquidations, order_book: orderBook, sources: { spot: "Bybit Spot public BTCUSDT market data", perpetual_futures: "Bybit USDT Perpetual public BTCUSDT market data", liquidations: "Bybit USDT Perpetual public BTCUSDT liquidation WebSocket" } };
}

export async function fetchCloudflareAlignedClose(timestampMs: number): Promise<number> {
  const candles = await fetchFinalizedCandles("1m", 2, timestampMs);
  const candle = referenceClose(candles, timestampMs);
  if (candle.closeTimeMs !== timestampMs - 1) throw new Error(`Expected a 1m candle ending ${iso(timestampMs - 1)}, received ${iso(candle.closeTimeMs)}`);
  return round(candle.close, 2);
}

export async function buildCloudflareExperimentState(boundaryMs: number, liquidationWindowMs: number): Promise<ExperimentState> {
  if (boundaryMs % MINUTE_MS !== 0) throw new Error("Experiment boundary must align to a UTC minute");
  const [auxiliary, oneMinute, fifteenMinute, oneHour, fourHour, dayRows] = await Promise.all([
    buildAuxiliary(liquidationWindowMs), fetchFinalizedCandles("1m", 250, boundaryMs), fetchFinalizedCandles("15m", 500, boundaryMs), fetchFinalizedCandles("1h", 500, boundaryMs), fetchFinalizedCandles("4h", 500, boundaryMs), fetchCandles("1d", 2, boundaryMs - 1),
  ]);
  const completedOneMinute = oneMinute.filter((candle) => candle.closeTimeMs < boundaryMs);
  const anchor = completedOneMinute.at(-1);
  if (!anchor || anchor.closeTimeMs !== boundaryMs - 1) throw new Error("The exact boundary-aligned Bybit Spot BTCUSDT 1m close is unavailable");
  const anchorPrice = anchor.close;
  const returnMinutes = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240 } as const;
  const returns = {} as ExperimentState["returns_pct"];
  for (const [label, minutes] of Object.entries(returnMinutes) as [keyof typeof returnMinutes, number][]) {
    returns[label] = round((anchorPrice / referenceClose(completedOneMinute, boundaryMs - minutes * MINUTE_MS).close - 1) * 100);
  }
  const dayStart = Math.floor(boundaryMs / DAY_MS) * DAY_MS;
  const dayEnd = dayStart + DAY_MS;
  const dayCandle = boundaryMs === dayStart ? null : [...dayRows].reverse().find((candle) => candle.openTimeMs === dayStart) ?? null;
  const dayOpen = dayCandle?.open ?? anchorPrice;
  const collected = Date.now();
  return {
    schema_version: "2.0.0",
    snapshot: { timestamp_utc: iso(boundaryMs), collected_at_utc: iso(collected), collection_lag_ms: collected - boundaryMs, cadence: "scheduled_15m", symbol: "BTCUSDT", quote_asset: "USDT", anchor_price_usdt: round(anchorPrice, 2), anchor_price_source: "Bybit Spot completed BTCUSDT 1m candle close" },
    targets: { "15m": iso(boundaryMs + 15 * MINUTE_MS), "1h": iso(boundaryMs + 60 * MINUTE_MS), "4h": iso(boundaryMs + 240 * MINUTE_MS), end_of_utc_day: iso(dayEnd) },
    returns_pct: returns,
    timeframes: { "15m": featureBlock("15m", fifteenMinute, boundaryMs, anchorPrice), "1h": featureBlock("1h", oneHour, boundaryMs, anchorPrice), "4h": featureBlock("4h", fourHour, boundaryMs, anchorPrice) },
    utc_session: { day_start_utc: iso(dayStart), day_end_utc: iso(dayEnd), minutes_until_day_end: (dayEnd - boundaryMs) / MINUTE_MS, open_usdt: round(dayOpen, 2), high_usdt: round(dayCandle?.high ?? anchorPrice, 2), low_usdt: round(dayCandle?.low ?? anchorPrice, 2), return_from_open_pct: round((anchorPrice / dayOpen - 1) * 100), base_volume_btc: round(dayCandle?.baseVolume ?? 0), quote_volume_usdt: round(dayCandle?.quoteVolume ?? 0, 2) },
    ...auxiliary,
  };
}
