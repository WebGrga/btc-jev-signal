import type {
  ExperimentReport,
  Horizon,
  HorizonReport,
  PredictionBatch,
  Settlement,
} from "./experiment-types.js";

const HORIZONS: Horizon[] = ["15m", "1h", "4h", "eod"];

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number | null, digits = 6): number | null {
  return value === null ? null : Number(value.toFixed(digits));
}

function horizonReport(
  horizon: Horizon | "overall",
  batches: readonly PredictionBatch[],
  settlements: readonly Settlement[],
): HorizonReport {
  const forecasts = batches
    .flatMap((batch) => batch.forecasts)
    .filter((forecast) => horizon === "overall" || forecast.horizon === horizon);
  const ids = new Set(forecasts.map((forecast) => forecast.forecast_id));
  const relevant = settlements.filter((settlement) => ids.has(settlement.forecast_id));
  const scored = relevant.filter((settlement) => settlement.correct !== null);
  const correct = scored.filter((settlement) => settlement.correct).length;
  const chosenProbabilities = forecasts
    .filter((forecast) => relevant.some((settlement) => settlement.forecast_id === forecast.forecast_id))
    .map((forecast) => forecast.probabilities[forecast.choice]);
  return {
    horizon,
    issued: forecasts.length,
    settled: relevant.length,
    pending: forecasts.length - relevant.length,
    ties: relevant.filter((settlement) => settlement.actual_direction === "unchanged").length,
    scored: scored.length,
    correct,
    accuracy: scored.length === 0 ? null : round(correct / scored.length),
    mean_brier_score: round(mean(scored.map((settlement) => settlement.brier_score!))),
    mean_log_loss: round(mean(scored.map((settlement) => settlement.log_loss!))),
    mean_chosen_probability: round(mean(chosenProbabilities)),
  };
}

export function buildReport(
  batches: readonly PredictionBatch[],
  settlements: readonly Settlement[],
): ExperimentReport {
  const forecastTimes = batches.map((batch) => batch.state.snapshot.timestamp_utc).sort();
  return {
    generated_at_utc: new Date().toISOString(),
    first_forecast_utc: forecastTimes[0] ?? null,
    last_forecast_utc: forecastTimes.at(-1) ?? null,
    reports: [
      ...HORIZONS.map((horizon) => horizonReport(horizon, batches, settlements)),
      horizonReport("overall", batches, settlements),
    ],
    note: "Rolling forecasts overlap, so observations are not statistically independent. Accuracy alone is incomplete; use Brier score and log loss to assess the probability distributions.",
  };
}

function displayPercent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function displayNumber(value: number | null): string {
  return value === null ? "—" : value.toFixed(4);
}

export function reportMarkdown(report: ExperimentReport): string {
  const rows = report.reports.map((item) =>
    `| ${item.horizon} | ${item.issued} | ${item.settled} | ${item.pending} | ${item.correct}/${item.scored} | ${displayPercent(item.accuracy)} | ${displayNumber(item.mean_brier_score)} | ${displayNumber(item.mean_log_loss)} |`,
  );
  return [
    "# BTC / Jev experiment report",
    "",
    `Generated: ${report.generated_at_utc}`,
    `Forecast range: ${report.first_forecast_utc ?? "—"} to ${report.last_forecast_utc ?? "—"}`,
    "",
    "| Horizon | Issued | Settled | Pending | Correct | Accuracy | Brier | Log loss |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    report.note,
    "",
    "A lower Brier score and lower log loss are better. Exact price ties are recorded but excluded from binary scoring.",
    "",
  ].join("\n");
}
