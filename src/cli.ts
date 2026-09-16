#!/usr/bin/env node
import "dotenv/config";
import { buildMarketState } from "./binance.js";
import { safeErrorMessage } from "./http.js";
import { predictDirection } from "./jev.js";
import type { MarketState, PredictionOutput } from "./types.js";

function parseWindowMs(): number {
  const raw = process.env.LIQUIDATION_WINDOW_MS ?? "3000";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 30_000) {
    throw new Error("LIQUIDATION_WINDOW_MS must be an integer between 0 and 30000");
  }
  return value;
}

function percent(value: number | null): string {
  return value === null ? "unavailable" : `${value.toFixed(4)}%`;
}

function marketSummary(state: MarketState): string {
  const futures = state.perpetual_futures;
  return [
    "BTC market snapshot",
    `  Snapshot: ${state.snapshot.timestamp_utc}`,
    `  Spot: ${state.spot.price_usdt.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT`,
    `  Returns: 1m ${percent(state.spot.returns_pct["1m"])} | 5m ${percent(state.spot.returns_pct["5m"])} | 15m ${percent(state.spot.returns_pct["15m"])} | 1h ${percent(state.spot.returns_pct["1h"])}`,
    `  RSI(14): ${state.indicators_1m.rsi_14.toFixed(2)}`,
    `  MACD: ${state.indicators_1m.macd_12_26_9.line.toFixed(2)} | signal ${state.indicators_1m.macd_12_26_9.signal.toFixed(2)} | histogram ${state.indicators_1m.macd_12_26_9.histogram.toFixed(2)}`,
    `  ATR(14): ${state.indicators_1m.atr_14_usdt.toFixed(2)} USDT (${percent(state.indicators_1m.atr_14_pct)})`,
    `  Funding: ${futures.last_funding_rate === null ? "unavailable" : futures.last_funding_rate.toFixed(8)}`,
    `  Open interest: ${futures.open_interest_btc === null ? "unavailable" : `${futures.open_interest_btc.toLocaleString("en-US")} BTC`}`,
    `  Order-book imbalance: ${state.order_book.imbalance?.toFixed(6) ?? "unavailable"}`,
    `  Liquidations observed: ${state.liquidations.event_count} event(s), ${state.liquidations.total_liquidation_notional_usdt.toFixed(2)} USDT in ${state.liquidations.observation_window_ms} ms`,
  ].join("\n");
}

function predictionSummary(output: PredictionOutput): string {
  const answer = output.jev.answer;
  return [
    marketSummary(output.state),
    "Jev 60-minute probability signal",
    `  Target: ${output.state.snapshot.target_timestamp_utc}`,
    `  Choice: ${answer.choice}`,
    `  Probabilities: higher ${(answer.probabilities.higher * 100).toFixed(2)}% | lower ${(answer.probabilities.lower * 100).toFixed(2)}% | unchanged ${(answer.probabilities.unchanged * 100).toFixed(2)}%`,
    `  Confidence: ${(answer.confidence * 100).toFixed(2)}%`,
    "  Experimental signal only; no trading or execution is performed.",
  ].join("\n");
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "predict";
  if (!new Set(["predict", "snapshot"]).has(command)) {
    throw new Error("Usage: npm run predict, or npm run snapshot");
  }

  const state = await buildMarketState(parseWindowMs());
  if (command === "snapshot") {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    process.stderr.write(`${marketSummary(state)}\n`);
    return;
  }

  const jev = await predictDirection(state);
  const output: PredictionOutput = {
    generated_at_utc: new Date().toISOString(),
    experimental_only: true,
    state,
    jev,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.stderr.write(`${predictionSummary(output)}\n`);
}

main().catch((error) => {
  process.stderr.write(`btc-jev-signal failed: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
