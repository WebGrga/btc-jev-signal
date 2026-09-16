import { useEffect, useMemo, useState } from "react";
import type {
  DashboardData,
  Direction,
  ForecastStatus,
  ForecastView,
  Horizon,
  HorizonReport,
  TimeframeFeatures,
} from "./types";

const HORIZONS: readonly Horizon[] = ["15m", "1h", "4h", "eod"];
const HORIZON_LABELS: Record<Horizon, string> = {
  "15m": "15 minutes",
  "1h": "1 hour",
  "4h": "4 hours",
  eod: "UTC day close",
};
const CADENCE_LABELS: Record<Horizon, string> = {
  "15m": "Every 15 min",
  "1h": "Every hour",
  "4h": "Every 4 hours",
  eod: "Once per UTC day",
};
const REFRESH_MS = 60_000;
const PREDICTOR_STALE_AFTER_MS = 30 * 60_000;

function formatUsd(value: number | null, digits = 2): string {
  if (value === null) return "Unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(value);
}

function formatProbability(value: number | null, digits = 1): string {
  return value === null ? "Pending" : `${(value * 100).toFixed(digits)}%`;
}

function formatPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "Unavailable";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function formatNumber(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined ? "Unavailable" : value.toFixed(digits);
}

function formatUtc(value: string, includeDate = true): string {
  return new Intl.DateTimeFormat("en-GB", {
    ...(includeDate ? { month: "short", day: "2-digit" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    hour12: false,
  }).format(new Date(value));
}

function timeDistance(target: string): string {
  const deltaMinutes = Math.round((Date.parse(target) - Date.now()) / 60_000);
  if (deltaMinutes <= 0) return "Settlement due";
  if (deltaMinutes < 60) return `${deltaMinutes}m remaining`;
  const hours = Math.floor(deltaMinutes / 60);
  const minutes = deltaMinutes % 60;
  return minutes ? `${hours}h ${minutes}m remaining` : `${hours}h remaining`;
}

function directionLabel(value: Direction): string {
  return value === "higher" ? "Higher" : "Lower";
}

function statusLabel(value: ForecastStatus): string {
  if (value === "correct") return "Correct";
  if (value === "incorrect") return "Incorrect";
  if (value === "tie") return "Exact tie";
  return "Pending";
}

function Info({ text }: { text: string }): React.JSX.Element {
  return <span className="info" tabIndex={0} role="note" aria-label={text} data-tip={text}>i</span>;
}

function useDashboard(): { data: DashboardData | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/btc-jev/api/dashboard", { cache: "no-store" });
        if (!response.ok) throw new Error(`Dashboard request failed (${response.status})`);
        const next = (await response.json()) as DashboardData;
        if (active) {
          setData(next);
          setError(null);
        }
      } catch (requestError) {
        if (active) setError(requestError instanceof Error ? requestError.message : "Dashboard request failed");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  return { data, error, loading };
}

function Sparkline({ data, horizon }: { data: DashboardData; horizon: Horizon }): React.JSX.Element {
  const values = data.probability_history
    .map((point) => point.higher_probability[horizon])
    .filter((value): value is number => value !== undefined)
    .slice(-32);
  if (values.length < 2) return <span className="sparkline-empty">History pending</span>;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 100;
    const y = 36 - value * 32;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg className="sparkline" viewBox="0 0 100 40" preserveAspectRatio="none" aria-label={`${HORIZON_LABELS[horizon]} higher-probability history`}>
      <line x1="0" y1="20" x2="100" y2="20" className="spark-mid" />
      <polyline points={points} className="spark-path" />
    </svg>
  );
}

function ForecastCard({ forecast, data, horizon }: { forecast: ForecastView | undefined; data: DashboardData; horizon: Horizon }): React.JSX.Element {
  if (!forecast) {
    return (
      <article className="forecast-card forecast-empty">
        <div><strong>{HORIZON_LABELS[horizon]}</strong><span>{CADENCE_LABELS[horizon]}</span></div>
        <p>Waiting for the first eligible forecast.</p>
      </article>
    );
  }
  const selected = forecast.probabilities[forecast.choice];
  return (
    <article className="forecast-card">
      <header>
        <div><h2>{HORIZON_LABELS[forecast.horizon]}</h2><span>{CADENCE_LABELS[forecast.horizon]}</span></div>
        <span className={`status status-${forecast.status}`}>{statusLabel(forecast.status)}</span>
      </header>
      <div className="forecast-decision"><strong>{directionLabel(forecast.choice)}</strong><b>{formatProbability(selected, 0)}</b></div>
      <div className="split-bar" aria-label={`Higher ${formatProbability(forecast.probabilities.higher)}, lower ${formatProbability(forecast.probabilities.lower)}`}>
        <span style={{ width: `${forecast.probabilities.higher * 100}%` }} />
      </div>
      <div className="split-labels"><span>Higher {formatProbability(forecast.probabilities.higher)}</span><span>Lower {formatProbability(forecast.probabilities.lower)}</span></div>
      <Sparkline data={data} horizon={forecast.horizon} />
      <dl className="forecast-meta">
        <div><dt>Issued</dt><dd>{formatUtc(forecast.origin_timestamp_utc)}</dd></div>
        <div><dt>Target</dt><dd>{formatUtc(forecast.target_timestamp_utc)}</dd></div>
        <div><dt>Anchor</dt><dd>{formatUsd(forecast.origin_price_usdt)}</dd></div>
        <div><dt>Confidence <Info text="Distribution concentration reported by Jev. It is not a guarantee of correctness." /></dt><dd>{formatProbability(forecast.confidence)}</dd></div>
      </dl>
      <footer>{forecast.status === "pending" ? timeDistance(forecast.target_timestamp_utc) : `Actual ${forecast.actual_direction ?? "pending"} ${formatPct(forecast.actual_return_pct)}`}</footer>
    </article>
  );
}

function PerformanceTable({ reports }: { reports: HorizonReport[] }): React.JSX.Element {
  const rows = reports.filter(
    (report): report is HorizonReport & { horizon: Horizon } => report.horizon !== "overall",
  );
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Window</th><th>Eligible</th><th>Resolved</th><th>Correct</th><th>Accuracy <Info text="Correct directional calls divided by scorable resolved calls. Exact price ties are excluded." /></th><th>Brier <Info text="Mean squared probability error. Lower is better; 0 is perfect." /></th><th>Log loss <Info text="Penalizes confident wrong probabilities strongly. Lower is better." /></th><th>Old overlap excluded <Info text="Forecasts created by the previous every-15-minute schedule are retained but excluded when they do not match this horizon's natural cadence." /></th></tr></thead>
        <tbody>
          {rows.map((report) => (
            <tr key={report.horizon}>
              <td><strong>{HORIZON_LABELS[report.horizon]}</strong><small>{CADENCE_LABELS[report.horizon]}</small></td>
              <td>{report.issued}</td><td>{report.settled}<small>{report.pending} pending</small></td><td>{report.correct} / {report.scored}</td>
              <td>{formatProbability(report.accuracy)}</td><td>{formatNumber(report.mean_brier_score)}</td><td>{formatNumber(report.mean_log_loss)}</td><td>{report.excluded_overlapping}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScheduleTable({ data }: { data: DashboardData }): React.JSX.Element {
  return (
    <table className="schedule-table">
      <thead><tr><th>Forecast</th><th>Issued</th><th>Target</th><th>Trials/day</th></tr></thead>
      <tbody>{HORIZONS.map((horizon) => (
        <tr key={horizon}><td>{HORIZON_LABELS[horizon]}</td><td>{CADENCE_LABELS[horizon]}</td><td>{horizon === "eod" ? "Next 00:00 UTC" : `Issue + ${HORIZON_LABELS[horizon]}`}</td><td>{data.schedule[horizon].expected_per_utc_day}</td></tr>
      ))}</tbody>
    </table>
  );
}

function TimeframeTable({ timeframe }: { timeframe: TimeframeFeatures }): React.JSX.Element {
  const movingKeys = ["sma_20", "sma_50", "sma_200", "ema_20", "ema_50", "ema_200"] as const;
  return (
    <div className="timeframe-content">
      <dl className="input-grid">
        <div><dt>Completed bar return</dt><dd>{formatPct(timeframe.completed_bar_return_pct)}</dd></div><div><dt>Four-bar return</dt><dd>{formatPct(timeframe.completed_4_bar_return_pct)}</dd></div>
        <div><dt>RSI (14)</dt><dd>{formatNumber(timeframe.rsi_14, 1)}</dd></div><div><dt>ATR (14)</dt><dd>{formatUsd(timeframe.atr_14_usdt)} · {formatPct(timeframe.atr_14_pct)}</dd></div>
        <div><dt>MACD line</dt><dd>{formatNumber(timeframe.macd_12_26_9.line)}</dd></div><div><dt>MACD signal</dt><dd>{formatNumber(timeframe.macd_12_26_9.signal)}</dd></div>
        <div><dt>MACD histogram</dt><dd>{formatNumber(timeframe.macd_12_26_9.histogram)}</dd></div><div><dt>Volume vs 20-bar mean</dt><dd>{formatNumber(timeframe.volume.latest_to_mean_20_bar_ratio, 2)}×</dd></div>
      </dl>
      <div className="ma-grid">{movingKeys.map((key) => (
        <div key={key}><span>{key.replace("_", " ").toUpperCase()}</span><strong>{formatUsd(timeframe.moving_averages_usdt[key])}</strong><small>Price distance {formatPct(timeframe.anchor_distance_from_moving_average_pct[key])}</small></div>
      ))}</div>
      <p className="source-line">Calculated through {formatUtc(timeframe.calculated_through_utc)} UTC using completed candles only.</p>
    </div>
  );
}

function ModelInputs({ data }: { data: DashboardData }): React.JSX.Element {
  const state = data.latest_batch!.state;
  const oi = state.perpetual_futures.open_interest_change_pct;
  return (
    <div className="input-stack">
      <details open><summary>Price returns supplied to every question</summary><dl className="input-grid five">{(["1m", "5m", "15m", "1h", "4h"] as const).map((window) => <div key={window}><dt>{window} return</dt><dd>{formatPct(state.returns_pct[window])}</dd></div>)}</dl></details>
      {(["15m", "1h", "4h"] as const).map((window) => <details key={window}><summary>{window} completed-candle indicators</summary><TimeframeTable timeframe={state.timeframes[window]} /></details>)}
      <details><summary>Perpetual futures, funding and open interest</summary><dl className="input-grid">
        <div><dt>Available</dt><dd>{state.perpetual_futures.available ? "Yes" : "No"}</dd></div><div><dt>Mark price</dt><dd>{formatUsd(state.perpetual_futures.mark_price_usdt)}</dd></div>
        <div><dt>Funding rate</dt><dd>{state.perpetual_futures.last_funding_rate === null ? "Unavailable" : `${(state.perpetual_futures.last_funding_rate * 100).toFixed(4)}%`}</dd></div><div><dt>Open interest</dt><dd>{state.perpetual_futures.open_interest_btc === null ? "Unavailable" : `${state.perpetual_futures.open_interest_btc.toLocaleString()} BTC`}</dd></div>
        <div><dt>OI change 5m</dt><dd>{formatPct(oi?.["5m"])}</dd></div><div><dt>OI change 15m</dt><dd>{formatPct(oi?.["15m"])}</dd></div><div><dt>OI change 1h</dt><dd>{formatPct(oi?.["1h"])}</dd></div><div><dt>Next funding</dt><dd>{state.perpetual_futures.next_funding_time_utc ? `${formatUtc(state.perpetual_futures.next_funding_time_utc)} UTC` : "Unavailable"}</dd></div>
      </dl></details>
      <details><summary>Order book, liquidations and UTC session</summary><dl className="input-grid">
        <div><dt>Book imbalance</dt><dd>{formatNumber(state.order_book.imbalance)}</dd></div><div><dt>Spread</dt><dd>{state.order_book.spread_bps === null ? "Unavailable" : `${state.order_book.spread_bps.toFixed(3)} bps`}</dd></div>
        <div><dt>Top bid notional</dt><dd>{formatUsd(state.order_book.bid_notional_usdt, 0)}</dd></div><div><dt>Top ask notional</dt><dd>{formatUsd(state.order_book.ask_notional_usdt, 0)}</dd></div>
        <div><dt>Liquidation events</dt><dd>{state.liquidations.available ? state.liquidations.event_count : "Unavailable"}</dd></div><div><dt>Long liquidations</dt><dd>{formatUsd(state.liquidations.long_liquidation_notional_usdt, 0)}</dd></div><div><dt>Short liquidations</dt><dd>{formatUsd(state.liquidations.short_liquidation_notional_usdt, 0)}</dd></div>
        <div><dt>UTC day return</dt><dd>{formatPct(state.utc_session.return_from_open_pct)}</dd></div><div><dt>UTC open</dt><dd>{formatUsd(state.utc_session.open_usdt)}</dd></div><div><dt>UTC high / low</dt><dd>{formatUsd(state.utc_session.high_usdt)} / {formatUsd(state.utc_session.low_usdt)}</dd></div>
      </dl></details>
      <details><summary>Exact structured State sent to Jev</summary><pre>{JSON.stringify(state, null, 2)}</pre></details>
    </div>
  );
}

function RecentForecasts({ forecasts }: { forecasts: ForecastView[] }): React.JSX.Element {
  return (
    <div className="table-scroll"><table><thead><tr><th>Issued UTC</th><th>Window</th><th>Prediction</th><th>Distribution</th><th>Target UTC</th><th>Observed</th><th>Result</th></tr></thead><tbody>
      {forecasts.slice(0, 24).map((forecast) => <tr key={forecast.forecast_id}>
        <td>{formatUtc(forecast.origin_timestamp_utc)}</td><td>{HORIZON_LABELS[forecast.horizon]}</td><td>{directionLabel(forecast.choice)} {formatProbability(forecast.probabilities[forecast.choice])}</td><td>H {formatProbability(forecast.probabilities.higher)} / L {formatProbability(forecast.probabilities.lower)}</td><td>{formatUtc(forecast.target_timestamp_utc)}</td><td>{forecast.actual_direction ? `${forecast.actual_direction} ${formatPct(forecast.actual_return_pct)}` : "Pending"}</td><td><span className={`status status-${forecast.status}`}>{statusLabel(forecast.status)}</span></td>
      </tr>)}
    </tbody></table></div>
  );
}

function Dashboard({ data, error }: { data: DashboardData; error: string | null }): React.JSX.Element {
  const latest = data.latest_batch!;
  const predictorIsStale = Date.now() - Date.parse(latest.state.snapshot.timestamp_utc) > PREDICTOR_STALE_AFTER_MS;
  const forecastByHorizon = useMemo(() => new Map(data.latest_forecasts.map((forecast) => [forecast.horizon, forecast])), [data.latest_forecasts]);
  return (
    <div className="app">
      <header className="appbar"><div className="brand-path"><a href="https://lab.rokogrga.com/" className="brand">RG Lab</a><span>/</span><a href="https://lab.rokogrga.com/btc-jev">BTC–Jev</a></div><nav><a href="#forecasts">Forecasts</a><a href="#scores">Scores</a><a href="#inputs">Inputs</a><a href="#log">Log</a></nav><span className={`research-chip ${predictorIsStale ? "predictor-stale" : "predictor-live"}`}>{predictorIsStale ? "Predictor stale" : "Predictor live"}</span></header>
      {error ? <div className="error-banner">Live refresh failed. Displaying the last successful response.</div> : null}
      {predictorIsStale ? <div className="error-banner">Scheduled predictor is delayed. The newest successful Jev snapshot is {formatUtc(latest.state.snapshot.timestamp_utc)} UTC.</div> : null}
      <main id="top" className="dashboard">
        <section className="summary-strip">
          <div className="price-block"><span>BTC snapshot</span><strong>{formatUsd(latest.state.snapshot.anchor_price_usdt)}</strong></div>
          <dl><div><dt>Snapshot UTC</dt><dd>{formatUtc(latest.state.snapshot.timestamp_utc)} UTC</dd></div><div><dt>Source</dt><dd>{latest.state.snapshot.anchor_price_source}</dd></div><div><dt>Scoring policy</dt><dd>Natural non-overlapping cadence</dd></div><div><dt>Dashboard generated</dt><dd>{formatUtc(data.generated_at_utc)} UTC</dd></div></dl>
          <p><strong>Experimental personal research.</strong> Not financial advice. No trades are placed.</p>
        </section>

        <section id="forecasts" className="panel-section">
          <div className="section-title"><div><span className="section-kicker">Current active calls</span><h1>What Jev predicts next</h1></div><p>Each card keeps the newest eligible forecast for that horizon visible until a newer naturally scheduled call replaces it.</p></div>
          <div className="forecast-grid">{HORIZONS.map((horizon) => <ForecastCard key={horizon} horizon={horizon} forecast={forecastByHorizon.get(horizon)} data={data} />)}</div>
        </section>

        <section className="explain-grid">
          <article className="panel"><header className="panel-header"><div><h2>Forecast lifecycle</h2><p>What enters the equation and how it becomes a score.</p></div></header><ol className="pipeline">
            <li><b>1</b><div><strong>Observe</strong><span>Completed Kraken spot candles and order book, plus available Binance futures measurements, are captured at an exact UTC boundary.</span></div></li><li><b>2</b><div><strong>Calculate</strong><span>Returns, RSI, MACD, ATR, volume and moving-average distances are produced in ordinary code.</span></div></li><li><b>3</b><div><strong>Ask Jev</strong><span>The neutral structured State and an atomic higher-or-lower question produce a full probability distribution.</span></div></li><li><b>4</b><div><strong>Freeze</strong><span>The original price, target timestamp and probabilities are saved before the outcome exists.</span></div></li><li><b>5</b><div><strong>Settle</strong><span>At the target, code retrieves the exact completed Kraken 1-minute close and calculates accuracy, Brier score and log loss.</span></div></li>
          </ol></article>
          <article className="panel"><header className="panel-header"><div><h2>Issue schedule</h2><p>Each horizon now creates one non-overlapping sequence of trials.</p></div></header><ScheduleTable data={data} /><p className="callout">The previous version asked all four questions every 15 minutes. Those records are preserved, but overlapping 1h, 4h and day-close calls are excluded from the primary score.</p></article>
        </section>

        <section id="scores" className="panel panel-section"><header className="panel-header split"><div><h2>Performance by horizon</h2><p>Do not combine these rows: they represent different questions, cadences and sample sizes.</p></div><span className="sample-warning">Early sample · descriptive only</span></header><PerformanceTable reports={data.report.reports} /></section>
        <section id="inputs" className="panel panel-section"><header className="panel-header"><div><h2>Exact inputs in the latest State</h2><p>Nothing below is a Jev explanation or feature weight. These are the measurements Jev received; expand any group to inspect it.</p></div></header><ModelInputs data={data} /></section>
        <section id="log" className="panel panel-section"><header className="panel-header"><div><h2>Eligible forecast log</h2><p>Only forecasts matching the natural schedule appear here. Each result compares its own issue price with its own exact target timestamp.</p></div></header><RecentForecasts forecasts={data.recent_forecasts} /></section>
        <section className="sources panel-section"><div><strong>Spot and indicators</strong><span>{latest.state.sources.spot}</span></div><div><strong>Funding and open interest</strong><span>{latest.state.sources.perpetual_futures}</span></div><div><strong>Liquidations</strong><span>{latest.state.sources.liquidations}</span></div><div><strong>Settlement</strong><span>{data.methodology.target_price_source}</span></div></section>
      </main>
      <footer className="site-footer"><span>RG Lab / BTC–Jev</span><span>Experimental signal research · Not financial advice</span></footer>
    </div>
  );
}

function ExperimentPage(): React.JSX.Element {
  const { data, error, loading } = useDashboard();
  useEffect(() => { document.title = "BTC–Jev — RG Lab"; }, []);
  if (loading && !data) return <main className="loading">Loading experiment data…</main>;
  if (!data?.latest_batch) return <main className="loading">The experiment is online and waiting for its first forecast.</main>;
  return <Dashboard data={data} error={error} />;
}

export function App(): React.JSX.Element {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/btc-jev" || path === "/") return <ExperimentPage />;
  return <main className="not-found"><div><span className="section-kicker">BTC–Jev</span><h1>Experiment page not found.</h1><a href="https://lab.rokogrga.com/btc-jev">Return to the dashboard →</a></div></main>;
}
