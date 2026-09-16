import assert from "node:assert/strict";
import test from "node:test";
import { atr, ema, macd, rsi, sma } from "../src/indicators.js";
import type { Candle } from "../src/types.js";

test("SMA and EMA are stable for a constant series", () => {
  const values = Array.from({ length: 250 }, () => 100);
  assert.ok(Math.abs(sma(values, 200) - 100) < 1e-9);
  assert.ok(Math.abs(ema(values, 200) - 100) < 1e-9);
});

test("RSI handles rising, falling, and flat series", () => {
  assert.equal(rsi(Array.from({ length: 30 }, (_, index) => index), 14), 100);
  assert.equal(rsi(Array.from({ length: 30 }, (_, index) => 30 - index), 14), 0);
  assert.equal(rsi(Array.from({ length: 30 }, () => 100), 14), 50);
});

test("MACD is zero for a constant series", () => {
  const value = macd(Array.from({ length: 100 }, () => 42));
  assert.deepEqual(value, { line: 0, signal: 0, histogram: 0 });
});

test("ATR matches a constant high-low range", () => {
  const candles: Candle[] = Array.from({ length: 40 }, (_, index) => ({
    openTimeMs: index * 60_000,
    open: 100,
    high: 102,
    low: 98,
    close: 100,
    baseVolume: 1,
    closeTimeMs: (index + 1) * 60_000 - 1,
    quoteVolume: 100,
    trades: 1,
    takerBuyBaseVolume: 0.5,
    takerBuyQuoteVolume: 50,
  }));
  assert.equal(atr(candles, 14), 4);
});
