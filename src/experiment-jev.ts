import { choice, TypeSafeClient, type JsonValue } from "@typesafe-ai/sdk";
import type {
  Direction,
  ExperimentState,
  Forecast,
  Horizon,
} from "./experiment-types.js";
import { HORIZON_ORDER } from "./experiment-schedule.js";

const CRITERIA = {
  higher: "The BTC spot price for `snapshot.symbol` at the exact target timestamp is greater than `snapshot.anchor_price_usdt`.",
  lower: "The BTC spot price for `snapshot.symbol` at the exact target timestamp is less than `snapshot.anchor_price_usdt`.",
} as const;

function directionQuestion(horizon: "15m" | "1h" | "4h") {
  return choice(
    {
      task: `Which ${horizon} BTC spot-price direction is more probable for the supplied market?`,
      reference_price: "Use `snapshot.anchor_price_usdt` at `snapshot.timestamp_utc`.",
      target: `Use the exact timestamp in \`targets.${horizon}\`.`,
      evidence: "Use the complete supplied state, including all 15m, 1h, and 4h feature blocks.",
      missing_data: "Treat null values or fields with available=false as unavailable evidence.",
    },
    CRITERIA,
  );
}

const horizonQuestions = {
  direction_15m: directionQuestion("15m"),
  direction_1h: directionQuestion("1h"),
  direction_4h: directionQuestion("4h"),
};

const eodQuestion = choice(
  {
    task: "Which BTC spot-price direction is more probable for the supplied market at the end of the current UTC day?",
    reference_price: "Use `snapshot.anchor_price_usdt` at `snapshot.timestamp_utc`.",
    target: "Use the exact timestamp in `targets.end_of_utc_day`.",
    evidence: "Use the observed market state and the three probability distributions in `horizon_forecasts`.",
    missing_data: "Treat null values or fields with available=false as unavailable evidence.",
  },
  CRITERIA,
);

function client(apiKey = process.env.TYPESAFE_API_KEY): TypeSafeClient {
  if (!apiKey?.trim()) {
    throw new Error("TYPESAFE_API_KEY is not set. Add it to .env before running the experiment.");
  }
  return new TypeSafeClient({
    apiKey,
    timeout: 15_000,
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

function forecastId(originIso: string, horizon: Horizon): string {
  return `${originIso.replace(/[-:.]/g, "").replace("Z", "Z")}_${horizon}`;
}

function toForecast(
  state: ExperimentState,
  horizon: Horizon,
  targetTimestamp: string,
  answer: {
    choice: Direction;
    confidence: number;
    probabilities: Record<Direction, number>;
  },
  model: string,
  stage: Forecast["stage"],
): Forecast {
  return {
    forecast_id: forecastId(state.snapshot.timestamp_utc, horizon),
    horizon,
    origin_timestamp_utc: state.snapshot.timestamp_utc,
    target_timestamp_utc: targetTimestamp,
    origin_price_usdt: state.snapshot.anchor_price_usdt,
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    model,
    stage,
  };
}

export async function predictExperiment(state: ExperimentState): Promise<{
  forecasts: Forecast[];
  usage: { parallel_horizons: unknown; eod_cascade: unknown };
}>;
export async function predictExperiment(
  state: ExperimentState,
  requestedHorizons: readonly Horizon[],
  apiKey?: string,
): Promise<{
  forecasts: Forecast[];
  usage: { parallel_horizons: unknown; eod_cascade: unknown };
}>;
export async function predictExperiment(
  state: ExperimentState,
  requestedHorizons: readonly Horizon[] = HORIZON_ORDER,
  apiKey?: string,
): Promise<{
  forecasts: Forecast[];
  usage: { parallel_horizons: unknown; eod_cascade: unknown };
}> {
  const requested = new Set(requestedHorizons);
  const regularHorizons = (["15m", "1h", "4h"] as const).filter((horizon) => requested.has(horizon));
  const typesafe = client(apiKey);
  const questions = Object.fromEntries(
    regularHorizons.map((horizon) => [`direction_${horizon}`, horizonQuestions[`direction_${horizon}`]]),
  );
  const parallel = regularHorizons.length > 0
    ? await typesafe.systemOne({
        state: state as unknown as Record<string, JsonValue>,
        questions,
      })
    : null;
  const forecasts: Forecast[] = regularHorizons.map((horizon) => {
    const answer = parallel!.answers[`direction_${horizon}`] as {
      choice: Direction;
      confidence: number;
      probabilities: Record<Direction, number>;
    };
    return toForecast(
      state,
      horizon,
      state.targets[horizon],
      answer,
      parallel!.model,
      "parallel_horizons",
    );
  });

  const cascadeState = {
    ...state,
    horizon_forecasts: Object.fromEntries(
      forecasts.map((forecast) => [
        forecast.horizon,
        {
          target_timestamp_utc: forecast.target_timestamp_utc,
          choice: forecast.choice,
          confidence: forecast.confidence,
          probabilities: forecast.probabilities,
        },
      ]),
    ),
  };
  const eod = requested.has("eod")
    ? await typesafe.systemOne({
        state: cascadeState as unknown as Record<string, JsonValue>,
        questions: { direction_eod: eodQuestion },
      })
    : null;
  if (eod) {
    forecasts.push(
      toForecast(
        state,
        "eod",
        state.targets.end_of_utc_day,
        eod.answers.direction_eod,
        eod.model,
        "eod_cascade",
      ),
    );
  }

  return {
    forecasts,
    usage: {
      parallel_horizons: parallel?.usage ?? null,
      eod_cascade: eod?.usage ?? null,
    },
  };
}
