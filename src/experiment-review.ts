import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { choice, noul, score, TypeSafeClient, type JsonValue } from "@typesafe-ai/sdk";
import type {
  Forecast,
  HistoricalAnalysisScope,
  HistoricalPerformanceSlice,
  Horizon,
  HypotheticalPnlScenario,
  PredictionBatch,
  Settlement,
} from "./experiment-types.js";
import { isPrimaryForecast } from "./experiment-schedule.js";
import { ensureExperimentDirectory, experimentPaths, loadBatches, loadSettlements } from "./experiment-store.js";

const HORIZONS: Horizon[] = ["15m", "1h", "4h", "eod"];
const ROUND_TRIP_COST_SCENARIOS_PCT = [0, 0.1, 0.2] as const;

const reviewQuestions = {
  repeatable_edge_strength: score(
    {
      task: "How strong is the evidence that the recorded forecasts contain a repeatable out-of-sample BTC directional edge?",
      evidence: "Judge the complete compact forecast history, the all-records and natural-schedule statistics, calibration, sample size, overlap, and regime coverage.",
      caution: "Do not treat a final win rate just above 50% as sufficient by itself.",
    },
    [
      "No credible edge evidence; results are compatible with noise or worse.",
      "Very weak evidence; a small hint exists but limitations dominate.",
      "Mixed early evidence; worth continued testing but not a reliable edge.",
      "Meaningful evidence across relevant slices, though more validation is needed.",
      "Strong, consistent evidence across horizons, time segments, and clean non-overlapping trials.",
    ],
  ),
  probability_calibration_quality: score(
    {
      task: "How well calibrated and decision-useful are Jev's recorded direction probabilities?",
      evidence: "Use accuracy, mean chosen probability, Brier score, log loss, and probability-bin outcomes. High stated probability with near-random accuracy is poor calibration.",
    },
    [
      "Severely miscalibrated or actively misleading.",
      "Poorly calibrated; confidence materially exceeds realized reliability.",
      "Mixed or inconclusive calibration.",
      "Reasonably calibrated and potentially decision-useful.",
      "Strong calibration across bins and time slices.",
    ],
  ),
  money_evidence: choice(
    {
      task: "What does this history support saying about profitability?",
      rules: "Use the fee-scenario calculations, but recognize that close-at-target signed returns are hypothetical, overlapping records cannot all share the same capital, lower calls imply short execution, and no stop-loss, take-profit, sizing, slippage, funding, or intraperiod path was recorded.",
    },
    {
      evidence_of_loss: "The hypothetical signed-return results are negative even before modest trading costs.",
      frictionless_only: "Returns look positive only before realistic costs or depend on overlapping/unexecutable assumptions.",
      fragile_positive: "Some positive net evidence survives modest assumed costs, but it is fragile across slices or horizons.",
      robust_positive: "Positive net evidence is consistent across clean slices and multiple cost assumptions.",
      cannot_determine: "The available endpoint-only experiment cannot support a profitability conclusion.",
    },
  ),
  dominant_limitation: choice(
    "Which single limitation most constrains interpreting this experiment as a trading strategy?",
    {
      missing_trade_lifecycle: "There is no defined entry execution, stop-loss, take-profit, exit behavior before the target, sizing, slippage, funding, or liquidation model.",
      overlapping_trials: "Many old forecasts overlap, so trials and hypothetical positions are not independent and capital use is undefined.",
      small_sample: "The clean sample is too small and covers too little market-regime diversity.",
      overconfidence: "The probability calibration is poor enough that the confidence values are the main problem.",
      timeframe_mismatch: "Inputs or decision cadence are too concentrated around the 15-minute cycle for the claimed horizons.",
      data_integrity: "Missing, stale, mismatched, or potentially leaked data is the primary concern.",
    },
  ),
  next_research_step: choice(
    "Which next experiment would produce the most decision-relevant evidence?",
    {
      define_trade_lifecycle: "Pre-register executable entry, stop-loss, take-profit, time exit, position sizing, fees, slippage, funding, and invalidation rules, then replay or collect outcomes.",
      collect_clean_sample: "Keep collecting only natural-cadence, non-overlapping forecasts across more days and regimes before changing the model.",
      calibrate_and_abstain: "Fit probability calibration and an abstention threshold, then test only sufficiently strong signals out of sample.",
      horizon_specific_models: "Separate state, questions, and evaluation design by horizon rather than sharing one broad snapshot workflow.",
      pause_experiment: "Stop spending inference budget because the current evidence argues against continued testing.",
    },
  ),
  timeframe_mismatch_material: noul(
    "Does the experiment's 15-minute collection cadence and shared multi-timeframe state materially weaken interpretation of the 1h, 4h, and end-of-day forecasts?",
    {
      true: "The cadence, overlapping issuance, feature freshness, or shared state makes longer-horizon evidence materially less trustworthy.",
      false: "The longer-horizon inputs and natural-schedule subset adequately support those horizons despite the collection cadence.",
    },
  ),
  profitability_claim_blocked: noul(
    "Is a claim about real trading profitability blocked by the absence of a pre-defined trade lifecycle and intraperiod price path?",
    {
      true: "Endpoint direction and return cannot establish executable P&L without the missing trade rules and path-dependent outcomes.",
      false: "The recorded endpoint data is sufficient to make a realistic profitability claim.",
    },
  ),
} as const;

type ReviewAnswers = {
  [K in keyof typeof reviewQuestions]: Awaited<ReturnType<TypeSafeClient["systemOne"]>>["answers"][string];
};

function round(value: number | null, digits = 6): number | null {
  return value === null ? null : Number(value.toFixed(digits));
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function signedReturn(forecast: Forecast, settlement: Settlement): number {
  return forecast.choice === "higher" ? settlement.actual_return_pct : -settlement.actual_return_pct;
}

function performanceSlice(
  horizon: Horizon | "overall",
  forecasts: readonly Forecast[],
  settlementById: ReadonlyMap<string, Settlement>,
): HistoricalPerformanceSlice {
  const selected = forecasts.filter((forecast) => horizon === "overall" || forecast.horizon === horizon);
  const pairs = selected.flatMap((forecast) => {
    const settlement = settlementById.get(forecast.forecast_id);
    return settlement ? [{ forecast, settlement }] : [];
  });
  const scored = pairs.filter(({ settlement }) => settlement.correct !== null);
  const returns = pairs.map(({ forecast, settlement }) => signedReturn(forecast, settlement));
  return {
    horizon,
    issued: selected.length,
    settled: pairs.length,
    scored: scored.length,
    correct: scored.filter(({ settlement }) => settlement.correct).length,
    accuracy: scored.length === 0 ? null : round(scored.filter(({ settlement }) => settlement.correct).length / scored.length),
    mean_chosen_probability: round(mean(pairs.map(({ forecast }) => forecast.probabilities[forecast.choice]))),
    mean_confidence: round(mean(pairs.map(({ forecast }) => forecast.confidence))),
    mean_signed_return_pct: round(mean(returns)),
    summed_independent_trade_return_pct: returns.length === 0 ? null : round(returns.reduce((sum, value) => sum + value, 0)),
  };
}

function pnlScenarios(
  forecasts: readonly Forecast[],
  settlementById: ReadonlyMap<string, Settlement>,
): HypotheticalPnlScenario[] {
  const grossReturns = forecasts.flatMap((forecast) => {
    const settlement = settlementById.get(forecast.forecast_id);
    return settlement ? [signedReturn(forecast, settlement)] : [];
  });
  return ROUND_TRIP_COST_SCENARIOS_PCT.map((cost) => {
    const netReturns = grossReturns.map((value) => value - cost);
    return {
      round_trip_cost_pct: cost,
      settled_trades: netReturns.length,
      profitable_trades_after_cost: netReturns.filter((value) => value > 0).length,
      mean_net_return_pct: round(mean(netReturns)),
      summed_independent_trade_return_pct: netReturns.length === 0 ? null : round(netReturns.reduce((sum, value) => sum + value, 0)),
    };
  });
}

function analysisScope(
  name: HistoricalAnalysisScope["name"],
  forecasts: readonly Forecast[],
  settlementById: ReadonlyMap<string, Settlement>,
  overlappingPositionsPossible: boolean,
): HistoricalAnalysisScope {
  return {
    name,
    overlapping_positions_possible: overlappingPositionsPossible,
    performance: [
      ...HORIZONS.map((horizon) => performanceSlice(horizon, forecasts, settlementById)),
      performanceSlice("overall", forecasts, settlementById),
    ],
    hypothetical_close_at_target_pnl: pnlScenarios(forecasts, settlementById),
  };
}

function probabilityBins(forecasts: readonly Forecast[], settlementById: ReadonlyMap<string, Settlement>) {
  const bins = [
    { label: "0.50-0.59", min: 0.5, max: 0.6 },
    { label: "0.60-0.69", min: 0.6, max: 0.7 },
    { label: "0.70-0.79", min: 0.7, max: 0.8 },
    { label: "0.80-0.89", min: 0.8, max: 0.9 },
    { label: "0.90-1.00", min: 0.9, max: 1.000001 },
  ];
  return bins.map((bin) => {
    const pairs = forecasts.flatMap((forecast) => {
      const settlement = settlementById.get(forecast.forecast_id);
      const probability = forecast.probabilities[forecast.choice];
      return settlement && probability >= bin.min && probability < bin.max ? [{ forecast, settlement, probability }] : [];
    });
    return {
      bin: bin.label,
      settled: pairs.length,
      accuracy: pairs.length === 0 ? null : round(pairs.filter(({ settlement }) => settlement.correct).length / pairs.length),
      mean_chosen_probability: round(mean(pairs.map(({ probability }) => probability))),
      mean_signed_return_pct: round(mean(pairs.map(({ forecast, settlement }) => signedReturn(forecast, settlement)))),
    };
  });
}

function timeSegments(forecasts: readonly Forecast[], settlementById: ReadonlyMap<string, Settlement>) {
  const settled = forecasts
    .filter((forecast) => settlementById.has(forecast.forecast_id))
    .sort((a, b) => a.origin_timestamp_utc.localeCompare(b.origin_timestamp_utc));
  return ["early", "middle", "late"].map((label, index) => {
    const start = Math.floor((settled.length * index) / 3);
    const end = Math.floor((settled.length * (index + 1)) / 3);
    const slice = settled.slice(start, end);
    return {
      segment: label,
      first_origin_utc: slice[0]?.origin_timestamp_utc ?? null,
      last_origin_utc: slice.at(-1)?.origin_timestamp_utc ?? null,
      ...performanceSlice("overall", slice, settlementById),
    };
  });
}

function compactHistory(batches: readonly PredictionBatch[], settlementById: ReadonlyMap<string, Settlement>) {
  return {
    tuple_keys: {
      batch_state: ["origin_utc", "cadence", "anchor_usdt", "return_1m_pct", "return_15m_pct", "return_1h_pct", "return_4h_pct", "perp_available", "liquidations_available", "order_book_available"],
      forecast: ["origin_utc", "horizon", "choice", "chosen_probability", "confidence", "natural_schedule_eligible", "settled", "actual_return_pct", "correct", "brier", "log_loss"],
    },
    batch_states: batches.map((batch) => [
      batch.state.snapshot.timestamp_utc,
      batch.state.snapshot.cadence,
      batch.state.snapshot.anchor_price_usdt,
      batch.state.returns_pct["1m"],
      batch.state.returns_pct["15m"],
      batch.state.returns_pct["1h"],
      batch.state.returns_pct["4h"],
      batch.state.perpetual_futures.available,
      batch.state.liquidations.available,
      batch.state.order_book.available,
    ]),
    forecasts: batches.flatMap((batch) => batch.forecasts.map((forecast) => {
      const settlement = settlementById.get(forecast.forecast_id);
      return [
        forecast.origin_timestamp_utc,
        forecast.horizon,
        forecast.choice,
        forecast.probabilities[forecast.choice],
        forecast.confidence,
        isPrimaryForecast(forecast),
        Boolean(settlement),
        settlement?.actual_return_pct ?? null,
        settlement?.correct ?? null,
        settlement?.brier_score ?? null,
        settlement?.log_loss ?? null,
      ];
    })),
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function createClient(apiKey = process.env.TYPESAFE_API_KEY): TypeSafeClient {
  if (!apiKey?.trim()) throw new Error("TYPESAFE_API_KEY is not set. Add it to .env before running the Jev review.");
  return new TypeSafeClient({
    apiKey,
    timeout: 30_000,
    logLevel: "warn",
    retry: {
      maxRetries: 3,
      backoffInitialMs: 500,
      backoffMaxMs: 5_000,
      maxRetryAfterMs: 60_000,
      respectRetryAfter: true,
    },
  });
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function pctPoints(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(4)}%`;
}

function distribution(answer: { probabilities: Readonly<Record<string, number>> }): string {
  return Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([label, probability]) => `${label} ${(probability * 100).toFixed(1)}%`)
    .join("; ");
}

function markdownForReview(review: any): string {
  const all = review.deterministic_analysis.scopes.find((scope: HistoricalAnalysisScope) => scope.name === "all_recorded_forecasts")!;
  const primary = review.deterministic_analysis.scopes.find((scope: HistoricalAnalysisScope) => scope.name === "primary_natural_schedule")!;
  const allOverall = all.performance.find((item: HistoricalPerformanceSlice) => item.horizon === "overall")!;
  const primaryOverall = primary.performance.find((item: HistoricalPerformanceSlice) => item.horizon === "overall")!;
  const judgments = review.jev.judgments;
  const sourceRows = review.sources.map((source: any) => `| ${source.file} | ${source.bytes} | \`${source.sha256}\` |`);
  const scopeRows = [all, primary].map((scope: HistoricalAnalysisScope) => {
    const item = scope.performance.find((candidate) => candidate.horizon === "overall")!;
    return `| ${scope.name} | ${item.issued} | ${item.settled} | ${item.correct}/${item.scored} | ${percent(item.accuracy)} | ${percent(item.mean_chosen_probability)} | ${pctPoints(item.mean_signed_return_pct)} |`;
  });
  const pnlRows = [all, primary].flatMap((scope: HistoricalAnalysisScope) => scope.hypothetical_close_at_target_pnl.map((scenario) =>
    `| ${scope.name} | ${scenario.round_trip_cost_pct.toFixed(2)}% | ${scenario.settled_trades} | ${scenario.profitable_trades_after_cost} | ${pctPoints(scenario.mean_net_return_pct)} | ${pctPoints(scenario.summed_independent_trade_return_pct)} |`,
  ));
  const choiceRows = ["money_evidence", "dominant_limitation", "next_research_step"].map((key) => {
    const answer = judgments[key];
    return `| ${key} | ${answer.choice} | ${(answer.confidence * 100).toFixed(1)}% | ${distribution(answer)} |`;
  });
  const scoreRows = ["repeatable_edge_strength", "probability_calibration_quality"].map((key) => {
    const answer = judgments[key];
    return `| ${key} | ${answer.score.toFixed(2)} / 4 | ${(answer.confidence * 100).toFixed(1)}% | ${distribution(answer)} |`;
  });
  return [
    "# Jev historical review",
    "",
    `Generated: ${review.generated_at_utc}`,
    `Jev model: ${review.jev.model}`,
    "",
    "## Bottom line",
    "",
    `The recorded all-history directional accuracy is ${percent(allOverall.accuracy)} (${allOverall.correct}/${allOverall.scored}), while the mean probability placed on the chosen direction is ${percent(allOverall.mean_chosen_probability)}. The cleaner natural-schedule subset is ${percent(primaryOverall.accuracy)} (${primaryOverall.correct}/${primaryOverall.scored}). These are descriptive results from a very short window, not evidence of a durable trading strategy.`,
    "",
    `Jev's structured profitability judgment is **${judgments.money_evidence.choice}**. Jev assigns ${(judgments.profitability_claim_blocked.noul * 100).toFixed(1)}% probability that a real-profitability claim is blocked by the missing trade lifecycle and intraperiod path.`,
    "",
    "## What was reviewed",
    "",
    "Every source file was read during this run. The append-only records were parsed completely and supplied to Jev as a compact batch-by-batch history, alongside the report JSON and Markdown.",
    "",
    "| Source | Bytes | SHA-256 |",
    "| --- | ---: | --- |",
    ...sourceRows,
    "",
    "## Directional results",
    "",
    "| Scope | Issued | Settled | Correct | Accuracy | Mean chosen probability | Mean signed endpoint return |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...scopeRows,
    "",
    "`all_recorded_forecasts` includes the original overlapping 1h, 4h, and end-of-day calls. `primary_natural_schedule` keeps 15m every 15 minutes, 1h hourly, 4h every four hours, and end-of-day once per UTC day.",
    "",
    "## Hypothetical endpoint P&L",
    "",
    "This is a sensitivity check, not a backtest: one equal-notional long/short position is assumed at the recorded anchor and closed exactly at the target. The sums treat each trade independently and are not portfolio returns. They omit spread, slippage, funding, borrow, liquidation, stop-loss, take-profit, and intraperiod price path.",
    "",
    "| Scope | Assumed round-trip cost | Trades | Profitable after cost | Mean net return | Sum of independent trade returns |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...pnlRows,
    "",
    "## Jev opinions",
    "",
    "Jev returns typed judgments and probabilities rather than prose. The full rubrics and raw distributions are preserved in `jev-review.json`.",
    "",
    "| Judgment | Result | Jev confidence | Distribution |",
    "| --- | --- | ---: | --- |",
    ...choiceRows,
    ...scoreRows,
    `| timeframe_mismatch_material | ${(judgments.timeframe_mismatch_material.noul * 100).toFixed(1)}% yes | — | yes/no probability |`,
    `| profitability_claim_blocked | ${(judgments.profitability_claim_blocked.noul * 100).toFixed(1)}% yes | — | yes/no probability |`,
    "",
    "## Known interpretation limits",
    "",
    "- The original history contains overlapping forecasts, so observations and hypothetical capital usage are not independent.",
    "- Endpoint direction is not a trade plan. No stop-loss, take-profit, sizing, fees, slippage, funding, borrow, liquidation, or early invalidation rule was frozen before outcomes.",
    "- Only origin and target closes are available here. Intraperiod excursions could hit a stop or target in either order and completely change realized P&L.",
    "- The sample spans less than a day and cannot represent varied BTC regimes.",
    "- A win rate near 50% can still make or lose money depending on payoff asymmetry and costs; accuracy alone cannot answer the money question.",
    "",
  ].join("\n");
}

export async function runHistoricalJevReview(apiKey?: string): Promise<{ jsonPath: string; markdownPath: string }> {
  const paths = experimentPaths();
  const sourcePaths = [paths.predictions, paths.reportJson, paths.reportMarkdown, paths.settlements];
  const [sourceTexts, batches, settlements] = await Promise.all([
    Promise.all(sourcePaths.map((sourcePath) => readFile(sourcePath, "utf8"))),
    loadBatches(paths),
    loadSettlements(paths),
  ]);
  const reportJsonText = sourceTexts[1]!;
  const reportMarkdownText = sourceTexts[2]!;
  const reportJson = JSON.parse(reportJsonText) as JsonValue;
  const allForecasts = batches.flatMap((batch) => batch.forecasts);
  const primaryForecasts = allForecasts.filter(isPrimaryForecast);
  const settlementById = new Map(settlements.map((settlement) => [settlement.forecast_id, settlement]));
  const forecastIds = new Set(allForecasts.map((forecast) => forecast.forecast_id));
  const sources = sourcePaths.map((sourcePath, index) => ({
    file: path.basename(sourcePath),
    bytes: Buffer.byteLength(sourceTexts[index]!, "utf8"),
    sha256: sha256(sourceTexts[index]!),
  }));
  const state = {
    purpose: "Independent structured review of a non-trading BTC direction-forecast experiment.",
    known_limitations_from_owner: {
      cadence: "The first version issued practically everything every 15 minutes, including overlapping longer horizons.",
      missing_trade_plan: "The experiment did not predefine stop-loss, take-profit, sizing, or what happens when the signal changes before the target.",
      endpoint_only: "Forecasts judge only whether the exact target close is above or below the origin close.",
    },
    methodology: {
      deterministic_code_does_math: true,
      jev_role: "Judge evidence quality, calibration, limitations, and the next research priority from the supplied facts.",
      pnl_proxy: "Signed origin-to-target return for equal-notional long/short calls, reduced by explicit round-trip cost scenarios.",
      pnl_proxy_is_not_a_backtest: true,
    },
    sources,
    supplied_report_json: reportJson,
    supplied_report_markdown: reportMarkdownText,
    parsed_record_counts: {
      batches: batches.length,
      forecasts: allForecasts.length,
      settlements: settlements.length,
      primary_natural_schedule_forecasts: primaryForecasts.length,
      orphan_settlements: settlements.filter((settlement) => !forecastIds.has(settlement.forecast_id)).length,
    },
    scopes: [
      analysisScope("all_recorded_forecasts", allForecasts, settlementById, true),
      analysisScope("primary_natural_schedule", primaryForecasts, settlementById, false),
    ],
    calibration_bins_all_records: probabilityBins(allForecasts, settlementById),
    chronological_thirds_all_records: timeSegments(allForecasts, settlementById),
    complete_compact_history: compactHistory(batches, settlementById),
  };

  const result = await createClient(apiKey).systemOne({
    state: state as unknown as Record<string, JsonValue>,
    questions: reviewQuestions,
  });
  const review = {
    schema_version: "1.0.0",
    generated_at_utc: new Date().toISOString(),
    sources,
    deterministic_analysis: {
      parsed_record_counts: state.parsed_record_counts,
      scopes: state.scopes,
      calibration_bins_all_records: state.calibration_bins_all_records,
      chronological_thirds_all_records: state.chronological_thirds_all_records,
    },
    jev: {
      model: result.model,
      usage: result.usage,
      judgments: result.answers as unknown as ReviewAnswers,
    },
    limitations: state.known_limitations_from_owner,
  };
  const jsonPath = path.join(paths.directory, "jev-review.json");
  const markdownPath = path.join(paths.directory, "jev-review.md");
  await ensureExperimentDirectory(paths);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(review, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, markdownForReview(review), "utf8"),
  ]);
  return { jsonPath, markdownPath };
}
