# BTC / Jev Lab

A public, non-trading BTC forecasting experiment using TypeSafe Jev with public Kraken spot and Binance futures market data.

Live dashboard: **https://btc-jev-signal.roko-experiments.workers.dev**

This is a personal software experiment, not financial advice, investment research, or a trading service. It never places or prepares trades.

## What the experiment does

At exact UTC boundaries, ordinary code collects a neutral structured market State. Jev answers atomic higher-or-lower questions with full probability distributions. Every forecast is frozen with its issue price and exact target timestamp. After the target passes, ordinary code retrieves the completed 1-minute close from the same spot source and calculates the outcome.

The primary experiment uses a natural, non-overlapping schedule:

| Forecast | Issued | Target | Maximum primary trials per UTC day |
| --- | --- | --- | ---: |
| 15 minutes | Every 15 minutes | Issue + 15 minutes | 96 |
| 1 hour | At the top of each hour | Issue + 1 hour | 24 |
| 4 hours | Every fourth UTC hour | Issue + 4 hours | 6 |
| UTC day close | At 00:00 UTC | Next 00:00 UTC | 1 |

An earlier version issued every horizon every 15 minutes. Those append-only records remain auditable, but overlapping 1-hour, 4-hour, and day-close forecasts are excluded from the primary dashboard scores unless their issue time matches the natural schedule.

## What Jev receives

Every State uses normalized UTC ISO 8601 timestamps and completed candles only.

| Measurement | Source and definition |
| --- | --- |
| Anchor and realized target | Cloudflare: Kraken Spot completed BTC/USD 1-minute candle. Local runner: Binance Spot completed BTCUSDT 1-minute candle. |
| Returns | 1m, 5m, 15m, 1h, and 4h from the runtime's spot source |
| 15m / 1h / 4h indicators | RSI(14), MACD(12,26,9), ATR(14), SMA/EMA 20/50/200, price distances, bar returns, and volume ratios from completed spot candles |
| UTC session | Spot open, high, low, volume, return from open, and minutes to 00:00 UTC |
| Perpetual futures | Funding, mark/index price, open interest, and OI changes from Binance USD-M Futures |
| Liquidations | Short timestamped observation of Binance's public BTCUSDT force-order WebSocket |
| Order book | Cloudflare: Kraken Spot top-20 levels. Local runner: Binance Spot top-20 levels. Both expose bid/ask notionals, spread, and imbalance. |

The State always identifies `snapshot.symbol`, `snapshot.quote_asset`, and every source string. Some stable JSON field names still end in `_usdt` for backward compatibility; in Cloudflare records those monetary values are USD, as declared by `quote_asset: "USD"`.

The 15m, 1h, and 4h questions share one State and run independently in one TypeSafe request when they are due together. The day-close question is a second-stage request that can consume the three horizon distributions. The API key stays server-side.

## Reading the dashboard

The dashboard intentionally separates four concepts:

1. **Active forecasts** show the newest eligible prediction for each horizon, its reference price, target, probability split, and Jev confidence.
2. **Forecast lifecycle** shows exactly how observed data becomes calculated State, a frozen prediction, and a scored outcome.
3. **Performance by horizon** keeps different time windows separate. Accuracy measures the selected direction. Brier score and log loss evaluate probability quality; lower is better.
4. **Exact inputs** exposes every major field and includes the complete JSON State for audit.

Small samples are descriptive only. Jev confidence describes concentration in the returned distribution, not guaranteed correctness.

## Cloudflare production architecture

- Cloudflare Workers serves the API and runs the scheduled experiment.
- Cloudflare Static Assets serves the compiled React dashboard.
- Cloudflare D1 stores prediction batches and settlements.
- Cloudflare Worker Secrets stores `TYPESAFE_API_KEY`.
- One Cron Trigger runs at minutes 1, 16, 31, and 46, allowing the just-completed Kraken candle to finalize before collection.

The production database is intentionally separate from `data/*.jsonl`. A new deployment starts a clean online history unless a local history import is deliberately approved and performed.

### Deploy

Requires Node.js 20.19 or newer and a Cloudflare account.

```powershell
npm install
npx wrangler login
npm run cloudflare:migrate
npx wrangler secret put TYPESAFE_API_KEY
npm run cloudflare:deploy
```

Cloudflare configuration is in `wrangler.jsonc`; the D1 schema is in `migrations/`.

Useful Cloudflare commands:

```powershell
npm run cloudflare:check   # Build and validate without publishing
npm run cloudflare:dev     # Local Worker/D1 development
npm run cloudflare:deploy  # Build and publish
```

## Local experiment

Copy `.env.example` to `.env`, add `TYPESAFE_API_KEY`, and run:

```powershell
npm install
npm run experiment
```

The local runner uses the same natural cadence and writes append-only records to `data/`. Restarting is safe; existing boundary IDs are not duplicated and overdue forecasts are settled on startup.

Other useful commands:

```powershell
npm run dashboard         # Read-only dashboard at http://127.0.0.1:3000
npm run experiment:once   # Immediate four-horizon diagnostic batch
npm run experiment:state  # Inspect State without calling Jev
npm run settle            # Settle due local forecasts
npm run report            # Regenerate local report files
npm run check
npm test
```

## Stored data

Local mode writes:

- `data/predictions.jsonl`: complete States and probability distributions.
- `data/settlements.jsonl`: target prices, realized returns, accuracy, Brier score, and log loss.
- `data/report.json` and `data/report.md`: aggregate summaries.

Cloudflare stores equivalent JSON records in indexed D1 tables. Credentials are never written to State, dashboard responses, or prediction records.

## Reliability

- Market HTTP requests use bounded retries and timeouts.
- TypeSafe requests use SDK retries and respect rate-limit guidance.
- Optional derivatives, order-book, or liquidation failures remain explicit in State.
- Forecast and settlement IDs are unique, making repeated scheduled delivery safe.
- The public API is read-only and returns no secret or TypeSafe usage metadata.
- Dashboard and API responses include restrictive security headers.
