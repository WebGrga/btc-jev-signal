import { writeFile } from "node:fs/promises";
import path from "node:path";
import { experimentPaths, ensureExperimentDirectory, loadBatches, loadSettlements } from "./experiment-store.js";
import { isPrimaryForecast } from "./experiment-schedule.js";
import type { Forecast, Horizon, PredictionBatch, Settlement } from "./experiment-types.js";

const HORIZONS: Horizon[] = ["15m", "1h", "4h", "eod"];
const QUARTILES = ["Q1 lowest", "Q2", "Q3", "Q4 highest"] as const;

interface Observation {
  forecast: Forecast;
  settlement: Settlement;
  features: Record<string, number | null>;
}

interface FeatureQuartile {
  quartile: string;
  n: number;
  min_feature_value: number | null;
  max_feature_value: number | null;
  mean_target_return_pct: number | null;
  target_higher_rate: number | null;
  jev_direction_accuracy: number | null;
  mean_jev_chosen_probability: number | null;
}

interface FeatureAnalysis {
  generated_at_utc: string;
  analysis_type: "exploratory_univariate_association";
  scope: "primary_natural_schedule_only";
  sample_counts: {
    batches: number;
    eligible_forecasts: number;
    settled_forecasts: number;
    scored_forecasts: number;
    excluded_legacy_overlapping_forecasts: number;
  };
  interpretation: string[];
  horizons: Array<{
    horizon: Horizon;
    settled: number;
    baseline_mean_target_return_pct: number | null;
    baseline_target_higher_rate: number | null;
    features: Array<{
      feature: string;
      available: number;
      quartiles: FeatureQuartile[];
    }>;
  }>;
}

function round(value: number | null, digits = 6): number | null {
  return value === null ? null : Number(value.toFixed(digits));
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function featureValues(batch: PredictionBatch): Record<string, number | null> {
  const state = batch.state;
  const values: Record<string, number | null> = {};
  const add = (name: string, value: number | null | undefined) => {
    values[name] = value !== null && value !== undefined && Number.isFinite(value) ? value : null;
  };

  for (const window of ["1m", "5m", "15m", "1h", "4h"] as const) {
    add(`return_${window}_pct`, state.returns_pct[window]);
  }
  for (const window of ["15m", "1h", "4h"] as const) {
    const timeframe = state.timeframes[window];
    add(`${window}.completed_bar_return_pct`, timeframe.completed_bar_return_pct);
    add(`${window}.completed_4_bar_return_pct`, timeframe.completed_4_bar_return_pct);
    add(`${window}.rsi_14`, timeframe.rsi_14);
    add(`${window}.macd_line`, timeframe.macd_12_26_9.line);
    add(`${window}.macd_signal`, timeframe.macd_12_26_9.signal);
    add(`${window}.macd_histogram`, timeframe.macd_12_26_9.histogram);
    add(`${window}.atr_14_pct`, timeframe.atr_14_pct);
    add(`${window}.volume_ratio_20`, timeframe.volume.latest_to_mean_20_bar_ratio);
    for (const [name, distance] of Object.entries(timeframe.anchor_distance_from_moving_average_pct)) {
      add(`${window}.distance_${name}_pct`, distance);
    }
  }
  add("utc_session.return_from_open_pct", state.utc_session.return_from_open_pct);
  add("perpetual.funding_rate", state.perpetual_futures.available ? state.perpetual_futures.last_funding_rate : null);
  for (const window of ["5m", "15m", "1h"] as const) {
    add(`perpetual.open_interest_change_${window}_pct`, state.perpetual_futures.available
      ? state.perpetual_futures.open_interest_change_pct?.[window]
      : null);
  }
  add("order_book.imbalance", state.order_book.available ? state.order_book.imbalance : null);
  add("order_book.spread_bps", state.order_book.available ? state.order_book.spread_bps : null);
  add("liquidations.count", state.liquidations.available ? state.liquidations.event_count : null);
  add("liquidations.long_notional_usdt", state.liquidations.available ? state.liquidations.long_liquidation_notional_usdt : null);
  add("liquidations.short_notional_usdt", state.liquidations.available ? state.liquidations.short_liquidation_notional_usdt : null);
  return values;
}

function observations(
  batches: readonly PredictionBatch[],
  settlements: readonly Settlement[],
): { eligible: Forecast[]; rows: Observation[] } {
  const settlementById = new Map(settlements.map((settlement) => [settlement.forecast_id, settlement]));
  const eligible = batches.flatMap((batch) => batch.forecasts).filter(isPrimaryForecast);
  const featuresByBatch = new Map(batches.map((batch) => [batch.batch_id, featureValues(batch)]));
  const batchByForecastId = new Map(batches.flatMap((batch) => batch.forecasts.map((forecast) => [forecast.forecast_id, batch] as const)));
  const rows = eligible.flatMap((forecast) => {
    const settlement = settlementById.get(forecast.forecast_id);
    const batch = batchByForecastId.get(forecast.forecast_id);
    if (!settlement || !batch) return [];
    return [{ forecast, settlement, features: featuresByBatch.get(batch.batch_id)! }];
  });
  return { eligible, rows };
}

function targetHigherRate(rows: readonly Observation[]): number | null {
  const directional = rows.filter(({ settlement }) => settlement.actual_direction !== "unchanged");
  return ratio(directional.filter(({ settlement }) => settlement.actual_direction === "higher").length, directional.length);
}

function directionAccuracy(rows: readonly Observation[]): number | null {
  const directional = rows.filter(({ settlement }) => settlement.correct !== null);
  return ratio(directional.filter(({ settlement }) => settlement.correct).length, directional.length);
}

function quartileRows(rows: readonly Observation[], feature: string): FeatureQuartile[] {
  const usable = rows
    .flatMap((row) => row.features[feature] === null ? [] : [{ row, value: row.features[feature]! }])
    .sort((left, right) => left.value - right.value);
  if (usable.length === 0) return QUARTILES.map((quartile) => ({
    quartile, n: 0, min_feature_value: null, max_feature_value: null,
    mean_target_return_pct: null, target_higher_rate: null,
    jev_direction_accuracy: null, mean_jev_chosen_probability: null,
  }));

  // Keep identical feature values together rather than splitting ties across bins.
  const groups: Array<{ value: number; items: typeof usable }> = [];
  for (const item of usable) {
    const last = groups.at(-1);
    if (last?.value === item.value) last.items.push(item);
    else groups.push({ value: item.value, items: [item] });
  }
  const bins: Array<typeof usable> = QUARTILES.map(() => []);
  let consumed = 0;
  for (const group of groups) {
    const centerRank = consumed + (group.items.length - 1) / 2;
    const bin = Math.min(3, Math.floor((centerRank / usable.length) * 4));
    bins[bin]!.push(...group.items);
    consumed += group.items.length;
  }

  return QUARTILES.map((quartile, index) => {
    const bin = bins[index]!;
    const binRows = bin.map(({ row }) => row);
    const directional = binRows.filter(({ settlement }) => settlement.actual_direction !== "unchanged");
    return {
      quartile,
      n: binRows.length,
      min_feature_value: bin.length ? round(bin[0]!.value) : null,
      max_feature_value: bin.length ? round(bin.at(-1)!.value) : null,
      mean_target_return_pct: round(mean(binRows.map(({ settlement }) => settlement.actual_return_pct))),
      target_higher_rate: ratio(directional.filter(({ settlement }) => settlement.actual_direction === "higher").length, directional.length),
      jev_direction_accuracy: directionAccuracy(binRows),
      mean_jev_chosen_probability: round(mean(binRows.map(({ forecast }) => forecast.probabilities[forecast.choice]))),
    };
  });
}

function buildAnalysis(batches: readonly PredictionBatch[], settlements: readonly Settlement[]): FeatureAnalysis {
  const { eligible, rows } = observations(batches, settlements);
  const features = [...new Set(rows.flatMap((row) => Object.keys(row.features)))].sort();
  return {
    generated_at_utc: new Date().toISOString(),
    analysis_type: "exploratory_univariate_association",
    scope: "primary_natural_schedule_only",
    sample_counts: {
      batches: batches.length,
      eligible_forecasts: eligible.length,
      settled_forecasts: rows.length,
      scored_forecasts: rows.filter(({ settlement }) => settlement.correct !== null).length,
      excluded_legacy_overlapping_forecasts: batches.flatMap((batch) => batch.forecasts).length - eligible.length,
    },
    interpretation: [
      "This report describes associations in saved natural-schedule forecasts; it does not estimate causal feature importance or prove predictive value.",
      "Quartiles are formed separately for each forecast horizon and feature. Identical values stay in the same quartile, so bins can be uneven or empty.",
      "Small samples, changing market regimes, many tested features, and repeated use of the same history can create false patterns. Do not use these in-sample results to change live forecast weights.",
      "A feature should be considered useful only after a pre-registered rule improves a later, untouched time period against simple baselines.",
    ],
    horizons: HORIZONS.map((horizon) => {
      const horizonRows = rows.filter(({ forecast }) => forecast.horizon === horizon);
      return {
        horizon,
        settled: horizonRows.length,
        baseline_mean_target_return_pct: round(mean(horizonRows.map(({ settlement }) => settlement.actual_return_pct))),
        baseline_target_higher_rate: targetHigherRate(horizonRows),
        features: features.map((feature) => ({
          feature,
          available: horizonRows.filter((row) => row.features[feature] !== null).length,
          quartiles: quartileRows(horizonRows, feature),
        })),
      };
    }),
  };
}

function percentage(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function markdown(analysis: FeatureAnalysis): string {
  const lines = [
    "# BTC/Jev feature association review",
    "",
    `Generated: ${analysis.generated_at_utc}`,
    `Natural-schedule settled forecasts: ${analysis.sample_counts.settled_forecasts} / ${analysis.sample_counts.eligible_forecasts} eligible`,
    `Overlapping legacy forecasts excluded: ${analysis.sample_counts.excluded_legacy_overlapping_forecasts}`,
    "",
    ...analysis.interpretation.flatMap((note) => [`> ${note}`, ""]),
  ];
  for (const horizon of analysis.horizons) {
    lines.push(
      `## ${horizon.horizon}`,
      "",
      `Settled n=${horizon.settled}; unconditional higher rate ${percentage(horizon.baseline_target_higher_rate)}; mean target return ${horizon.baseline_mean_target_return_pct === null ? "—" : `${horizon.baseline_mean_target_return_pct.toFixed(4)}%`}.`,
      "",
      "| Feature | Available | Q1 low: n / higher / mean return / Jev hit | Q2 | Q3 | Q4 high |",
      "| --- | ---: | --- | --- | --- | --- |",
      ...horizon.features.map((feature) => {
        const bins = feature.quartiles.map((bin) => `${bin.n} / ${percentage(bin.target_higher_rate)} / ${bin.mean_target_return_pct === null ? "—" : `${bin.mean_target_return_pct.toFixed(4)}%`} / ${percentage(bin.jev_direction_accuracy)}`);
        return `| ${feature.feature} | ${feature.available}/${horizon.settled} | ${bins.join(" | ")} |`;
      }),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function writeFeatureAssociationReport(): Promise<{ jsonPath: string; markdownPath: string }> {
  const [batches, settlements] = await Promise.all([loadBatches(), loadSettlements()]);
  const analysis = buildAnalysis(batches, settlements);
  const paths = experimentPaths();
  const jsonPath = path.join(paths.directory, "feature-associations.json");
  const markdownPath = path.join(paths.directory, "feature-associations.md");
  await ensureExperimentDirectory(paths);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, markdown(analysis), "utf8"),
  ]);
  return { jsonPath, markdownPath };
}
