import type { Candle } from "./types.js";

function requireLength(values: readonly number[], length: number, name: string): void {
  if (values.length < length) {
    throw new Error(`${name} requires at least ${length} values; received ${values.length}`);
  }
}

export function sma(values: readonly number[], period: number): number {
  requireLength(values, period, `SMA(${period})`);
  const window = values.slice(-period);
  return window.reduce((sum, value) => sum + value, 0) / period;
}

export function emaSeries(values: readonly number[], period: number): number[] {
  requireLength(values, period, `EMA(${period})`);
  const multiplier = 2 / (period + 1);
  const result: number[] = [];
  let current = values[0]!;
  result.push(current);
  for (let index = 1; index < values.length; index += 1) {
    current = values[index]! * multiplier + current * (1 - multiplier);
    result.push(current);
  }
  return result;
}

export function ema(values: readonly number[], period: number): number {
  return emaSeries(values, period).at(-1)!;
}

export function rsi(values: readonly number[], period = 14): number {
  requireLength(values, period + 1, `RSI(${period})`);
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index]! - values[index - 1]!;
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function macd(
  values: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): { line: number; signal: number; histogram: number } {
  requireLength(values, slowPeriod + signalPeriod, "MACD");
  const fast = emaSeries(values, fastPeriod);
  const slow = emaSeries(values, slowPeriod);
  const lines = values.map((_, index) => fast[index]! - slow[index]!);
  const line = lines.at(-1)!;
  const signal = ema(lines, signalPeriod);
  return { line, signal, histogram: line - signal };
}

export function atr(candles: readonly Candle[], period = 14): number {
  requireLength(candles.map((candle) => candle.close), period + 1, `ATR(${period})`);
  const trueRanges: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const previousClose = candles[index - 1]!.close;
    trueRanges.push(
      Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose),
      ),
    );
  }
  let current = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let index = period; index < trueRanges.length; index += 1) {
    current = (current * (period - 1) + trueRanges[index]!) / period;
  }
  return current;
}
