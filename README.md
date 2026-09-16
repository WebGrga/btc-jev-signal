# BTC / Jev continuous experiment

This project runs a live, non-trading BTC forecasting experiment. Every 15 minutes it records one boundary-aligned market state, asks TypeSafe Jev for rolling 15-minute, 1-hour, and 4-hour direction probabilities, then asks a second end-of-UTC-day question that can see all three earlier probability distributions. Later, ordinary code retrieves the exact target candle close and scores what happened.

It never places or prepares trades.

## Quick start

Requires Node.js 20 or newer. Keep the terminal open while the experiment runs.

```powershell
npm install
Copy-Item .env.example .env
# Put TYPESAFE_API_KEY in .env
npm run experiment
```

The runner waits for the next UTC 15-minute boundary, then repeats until you press Ctrl+C. It writes durable results under `data/` and produces `data/report.md` and `data/report.json`. Stopping with Ctrl+C writes the latest report cleanly.

Useful commands:

```powershell
# Make one immediate, minute-aligned four-horizon batch for a smoke test
npm run experiment:once

# Inspect the multi-timeframe State without calling Jev
npm run experiment:state

# Settle every forecast whose target time has passed
npm run settle

# Print and regenerate the current report
npm run report
```

Restarting `npm run experiment` is safe. Existing boundary IDs are not duplicated, and overdue forecasts are settled on startup.

## What is forecast

Every scheduled batch has the same anchor: the Binance BTCUSDT 1-minute candle close at the exact UTC 15-minute boundary.

| Forecast | Target | Jev stage |
| --- | --- | --- |
| `15m` | Anchor + 15 minutes | Parallel request |
| `1h` | Anchor + 60 minutes | Parallel request |
| `4h` | Anchor + 240 minutes | Parallel request |
| `eod` | Next 00:00 UTC | Second request, with the 15m/1h/4h distributions added to State |

The first three questions share one structured State and run together. That State contains completed-candle measurements for the 15m, 1h, and 4h timeframes, so the 1-hour judgment sees both lower- and higher-timeframe evidence. TypeSafe questions in one request are independent, so the end-of-day forecast uses a second request to explicitly consume the three earlier distributions.

Each forecast is a binary `higher`/`lower` Choice. The old one-shot command included an `unchanged` option meaning exactly the same cent; that is not used in the scored experiment because it confuses directional uncertainty with literal price equality. A rare exact tie is recorded and excluded from binary scoring.

## Market State

All timestamps are UTC ISO 8601. Scheduled experiment States use schema `2.0.0` and the same fields every run.

| Measurement | Source and definition |
| --- | --- |
| Anchor and realized target price | Binance Spot completed 1-minute BTCUSDT candle close at the exact boundary |
| Returns | Boundary anchor versus 1m candle closes 1m, 5m, 15m, 1h, and 4h earlier |
| 15m / 1h / 4h indicators | RSI(14), MACD(12,26,9), ATR(14), SMA/EMA 20/50/200, price distances, completed-bar returns, and volume ratios using completed candles only |
| UTC-day session | Open, high, low, volume, return from open, and minutes remaining until 00:00 UTC |
| Funding and open interest | Binance USD-M Futures BTCUSDT public REST |
| Liquidations | Binance USD-M Futures public `btcusdt@forceOrder` stream during the timestamped observation window |
| Order-book imbalance | Binance Spot top 20 levels: `(bid notional - ask notional) / total notional` |

Completed higher-timeframe candles are deliberate: they prevent a historical candle's eventual close/high/low from leaking into an earlier live forecast.

## Files produced

- `data/predictions.jsonl`: append-only forecast batches, including the complete State Jev saw and every probability distribution.
- `data/settlements.jsonl`: realized target prices, returns, direction, correctness, Brier score, and log loss.
- `data/report.md`: readable results table by 15m, 1h, 4h, end-of-day, and overall.
- `data/report.json`: the same aggregate report as structured JSON.

JSONL makes the run crash-tolerant and auditable. The original inputs and raw probability distributions remain available for later analysis.

## Reading the report

The report shows issued, settled, pending, ties, directional accuracy, mean Brier score, and mean log loss for each horizon.

- Higher accuracy is better.
- Lower Brier score is better.
- Lower log loss is better and strongly penalizes confidently wrong forecasts.
- Rolling forecasts overlap, so they are not independent trials. Treat one day as an initial diagnostic, not proof of predictive value.

## Configuration

`.env.example` documents all options:

- `TYPESAFE_API_KEY`: required for forecasts and never written into State or output.
- `LIQUIDATION_WINDOW_MS`: default `3000`; set to `0` to disable the short live observation.
- `BOUNDARY_DELAY_MS`: default `10000`; allows the just-finished candle to begin propagating after each 15-minute boundary.
- `CANDLE_FINALIZATION_TIMEOUT_MS`: default `60000`; polls Binance for the exact boundary candle instead of skipping a forecast when the market-data mirror is delayed.
- `EXPERIMENT_DATA_DIR`: default `data`.

REST calls retry connection failures, HTTP 408/429, and 5xx responses with bounded backoff and `Retry-After` support. TypeSafe calls use three SDK retries. Optional live derivatives/order-book/liquidation failures remain explicit in State rather than disappearing.

## Legacy one-shot commands

The original 60-minute prototype remains available:

```powershell
npm run predict
npm run snapshot
```

Use the continuous experiment for scored testing.

## Checks

```powershell
npm run check
npm test
```
