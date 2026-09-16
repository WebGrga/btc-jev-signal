import {
  Badge,
  MessageBar,
  MessageBarBody,
  Tooltip,
} from "@fluentui/react-components";
import { lazy, Suspense, useEffect, useState } from "react";
import type {
  DashboardData,
  Direction,
  ForecastStatus,
  ForecastView,
  Horizon,
  HorizonReport,
} from "./types";

const HORIZON_LABELS: Record<Horizon, string> = {
  "15m": "15 minutes",
  "1h": "1 hour",
  "4h": "4 hours",
  eod: "UTC day close",
};

const REFRESH_MS = 60_000;
const ProbabilityChart = lazy(() => import("./ProbabilityChart"));

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function formatSignedPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "Unavailable";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function formatUtc(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: false,
  }).format(new Date(value));
}

function formatTargetDistance(target: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(target) - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes} min remaining`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} hr remaining` : `${hours} hr ${remainder} min remaining`;
}

function statusLabel(status: ForecastStatus): string {
  if (status === "correct") return "Correct";
  if (status === "incorrect") return "Incorrect";
  if (status === "tie") return "Exact tie";
  return "Pending";
}

function directionLabel(direction: Direction): string {
  return direction === "higher" ? "Higher" : "Lower";
}

function useDashboard(): {
  data: DashboardData | null;
  error: string | null;
  loading: boolean;
} {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/dashboard", { cache: "no-store" });
        if (!response.ok) throw new Error(`Dashboard request failed (${response.status})`);
        const next = (await response.json()) as DashboardData;
        if (active) {
          setData(next);
          setError(null);
        }
      } catch (requestError) {
        if (active) {
          setError(requestError instanceof Error ? requestError.message : "Dashboard request failed");
        }
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

function ProbabilitySplit({ forecast }: { forecast: ForecastView }): React.JSX.Element {
  const chosenProbability = forecast.probabilities[forecast.choice];
  return (
    <div className="probability-block" aria-label={`${directionLabel(forecast.choice)} ${formatPercent(chosenProbability)}`}>
      <div className="probability-reading">
        <strong>{formatPercent(chosenProbability, 0)}</strong>
        <span>{directionLabel(forecast.choice)}</span>
      </div>
      <div className="probability-track" aria-hidden="true">
        <span style={{ width: `${forecast.probabilities.higher * 100}%` }} />
      </div>
      <div className="probability-legend">
        <span>Higher {formatPercent(forecast.probabilities.higher)}</span>
        <span>Lower {formatPercent(forecast.probabilities.lower)}</span>
      </div>
    </div>
  );
}

function ForecastCard({ forecast, featured }: { forecast: ForecastView; featured?: boolean }): React.JSX.Element {
  return (
    <article className={`forecast-card${featured ? " forecast-card-featured" : ""}`}>
      <div className="forecast-heading">
        <div>
          <p className="forecast-horizon">{HORIZON_LABELS[forecast.horizon]}</p>
          <p className="forecast-target">Target {formatUtc(forecast.target_timestamp_utc)} UTC</p>
        </div>
        <Tooltip content="TypeSafe confidence summarizes how concentrated the full probability distribution is." relationship="description">
          <Badge className="confidence-badge" appearance="outline" color="subtle" size="small">
            Confidence {formatPercent(forecast.confidence, 0)}
          </Badge>
        </Tooltip>
      </div>
      <ProbabilitySplit forecast={forecast} />
      <div className="forecast-footer">
        <span>{formatTargetDistance(forecast.target_timestamp_utc)}</span>
        <span className={`status status-${forecast.status}`}>{statusLabel(forecast.status)}</span>
      </div>
    </article>
  );
}

function LoadingView(): React.JSX.Element {
  return (
    <main className="page-shell" aria-busy="true">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-lead" />
      <div className="skeleton-grid">
        <div className="skeleton skeleton-panel" />
        <div className="skeleton skeleton-panel" />
        <div className="skeleton skeleton-panel" />
      </div>
    </main>
  );
}

function EmptyView(): React.JSX.Element {
  return (
    <section className="empty-state">
      <p className="eyebrow">Awaiting the first run</p>
      <h1>The experiment is online.</h1>
      <p>The first scored forecast will appear after the next completed 15-minute boundary.</p>
    </section>
  );
}

function ProbabilityHistory({ data }: { data: DashboardData }): React.JSX.Element {
  return (
    <div className="chart-wrap" role="img" aria-label="Higher probability history by forecast horizon">
      <Suspense fallback={<div className="skeleton chart-skeleton" />}>
        <ProbabilityChart history={data.probability_history} />
      </Suspense>
    </div>
  );
}

function formatReportMetric(value: number | null, kind: "percent" | "number"): string {
  if (value === null) return "Pending";
  return kind === "percent" ? formatPercent(value) : value.toFixed(3);
}

function PerformanceTable({ reports }: { reports: HorizonReport[] }): React.JSX.Element {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Horizon</th>
            <th>Settled</th>
            <th>Accuracy</th>
            <th>Brier</th>
            <th>Log loss</th>
            <th>Mean conviction</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((report) => (
            <tr key={report.horizon}>
              <td>{report.horizon === "overall" ? "Overall" : HORIZON_LABELS[report.horizon]}</td>
              <td>{report.settled} / {report.issued}</td>
              <td>{formatReportMetric(report.accuracy, "percent")}</td>
              <td>{formatReportMetric(report.mean_brier_score, "number")}</td>
              <td>{formatReportMetric(report.mean_log_loss, "number")}</td>
              <td>{formatReportMetric(report.mean_chosen_probability, "percent")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function actualLabel(forecast: ForecastView): string {
  if (forecast.actual_direction === null) return "Pending";
  if (forecast.actual_direction === "unchanged") return "Unchanged";
  return directionLabel(forecast.actual_direction);
}

function RecentForecasts({ forecasts }: { forecasts: ForecastView[] }): React.JSX.Element {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Issued</th>
            <th>Horizon</th>
            <th>Jev</th>
            <th>Probability</th>
            <th>Actual</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {forecasts.slice(0, 16).map((forecast) => (
            <tr key={forecast.forecast_id}>
              <td>{formatUtc(forecast.origin_timestamp_utc)} UTC</td>
              <td>{HORIZON_LABELS[forecast.horizon]}</td>
              <td>{directionLabel(forecast.choice)}</td>
              <td>{formatPercent(forecast.probabilities[forecast.choice])}</td>
              <td>{actualLabel(forecast)}</td>
              <td><span className={`status status-${forecast.status}`}>{statusLabel(forecast.status)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModelState({ data }: { data: DashboardData }): React.JSX.Element {
  const state = data.latest_batch!.state;
  const funding = state.perpetual_futures.last_funding_rate;
  const openInterest = state.perpetual_futures.open_interest_change_pct;
  const metrics = [
    ["15m return", formatSignedPercent(state.returns_pct["15m"])],
    ["1h return", formatSignedPercent(state.returns_pct["1h"])],
    ["4h return", formatSignedPercent(state.returns_pct["4h"])],
    ["15m RSI", state.timeframes["15m"].rsi_14.toFixed(1)],
    ["1h RSI", state.timeframes["1h"].rsi_14.toFixed(1)],
    ["4h RSI", state.timeframes["4h"].rsi_14.toFixed(1)],
    ["Funding", funding === null ? "Unavailable" : `${(funding * 100).toFixed(4)}%`],
    ["OI change 1h", formatSignedPercent(openInterest?.["1h"])],
    ["Book imbalance", state.order_book.imbalance === null ? "Unavailable" : state.order_book.imbalance.toFixed(3)],
    ["Spread", state.order_book.spread_bps === null ? "Unavailable" : `${state.order_book.spread_bps.toFixed(3)} bps`],
    ["Liquidations", state.liquidations.available ? `${state.liquidations.event_count} observed` : "Unavailable"],
    ["UTC day", formatSignedPercent(state.utc_session.return_from_open_pct)],
  ] as const;

  return (
    <div className="metric-grid">
      {metrics.map(([label, value]) => (
        <div className="metric" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

export function App(): React.JSX.Element {
  const { data, error, loading } = useDashboard();
  if (loading && !data) return <LoadingView />;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="BTC Jev experiment home">
          <span>Roko</span>
          <strong>Experiments</strong>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#forecast">Forecast</a>
          <a href="#performance">Performance</a>
          <a href="#method">Method</a>
        </nav>
        <Badge className="public-badge" appearance="outline" color="subtle">Public research</Badge>
      </header>

      {error ? (
        <MessageBar intent="warning">
          <MessageBarBody>Live refresh failed. The most recent loaded results remain visible.</MessageBarBody>
        </MessageBar>
      ) : null}

      {!data?.latest_batch ? <EmptyView /> : (
        <main id="top" className="page-shell">
          <section className="hero" id="forecast">
            <div className="hero-copy">
              <p className="eyebrow">Live TypeSafe Jev experiment</p>
              <h1>What does Jev think BTC does next?</h1>
              <p>Four probability forecasts, issued every 15 minutes and scored against the exact later candle close.</p>
              <div className="notice">
                <strong>Personal research.</strong>
                <span>Experimental signal generator. Not financial advice. No trades are placed.</span>
              </div>
            </div>
            <aside className="price-panel">
              <span>BTC at snapshot</span>
              <strong>{formatUsd(data.latest_batch.state.snapshot.anchor_price_usdt)}</strong>
              <p>{formatUtc(data.latest_batch.state.snapshot.timestamp_utc)} UTC</p>
              <small>Binance Spot completed 1-minute candle</small>
            </aside>
          </section>

          <section aria-labelledby="latest-title">
            <div className="section-heading">
              <h2 id="latest-title">Latest forecast set</h2>
              <p>Full distributions are shown. Confidence describes concentration, not guaranteed correctness.</p>
            </div>
            <div className="forecast-grid">
              {data.latest_forecasts.map((forecast, index) => (
                <ForecastCard key={forecast.forecast_id} forecast={forecast} featured={index === 0} />
              ))}
            </div>
          </section>

          <section className="history-section" aria-labelledby="history-title">
            <div className="section-heading">
              <h2 id="history-title">How the view has moved</h2>
              <p>Each line is Jev's probability that BTC will be higher at that forecast's target.</p>
            </div>
            <ProbabilityHistory data={data} />
          </section>

          <section id="performance" className="performance-section" aria-labelledby="performance-title">
            <div className="section-heading">
              <h2 id="performance-title">Scored performance</h2>
              <p>Accuracy answers direction. Brier score and log loss reveal whether the probabilities deserve their confidence.</p>
            </div>
            <PerformanceTable reports={data.report.reports} />
            <p className="fine-print">Rolling forecasts overlap and are not independent trials. Small samples are descriptive, not proof of predictive value.</p>
          </section>

          <section className="state-section" aria-labelledby="state-title">
            <div className="section-heading">
              <h2 id="state-title">What Jev saw</h2>
              <p>A compact view of the neutral numeric State attached to the latest forecast request.</p>
            </div>
            <ModelState data={data} />
          </section>

          <section aria-labelledby="recent-title">
            <div className="section-heading">
              <h2 id="recent-title">Recent calls</h2>
              <p>Pending forecasts remain visible until their target candle closes and settlement succeeds.</p>
            </div>
            <RecentForecasts forecasts={data.recent_forecasts} />
          </section>

          <section id="method" className="method-section" aria-labelledby="method-title">
            <div>
              <h2 id="method-title">A forecast you can inspect</h2>
              <p>Market measurements come from Binance public Spot and USD-M Futures data. Jev returns typed higher or lower probabilities through TypeSafe.</p>
            </div>
            <div className="method-details">
              <div>
                <strong>Fixed cadence</strong>
                <span>Every UTC 15-minute boundary</span>
              </div>
              <div>
                <strong>Exact scoring</strong>
                <span>Completed 1-minute candle at the target</span>
              </div>
              <div>
                <strong>Open methodology</strong>
                <span>Inputs, forecasts, settlements, and proper scores</span>
              </div>
            </div>
          </section>
        </main>
      )}

      <footer>
        <p>BTC / Jev is a personal software experiment. It is not financial advice, investment research, or a trading service.</p>
        <p>Last dashboard refresh {data ? formatUtc(data.generated_at_utc) : "pending"} UTC</p>
      </footer>
    </div>
  );
}
