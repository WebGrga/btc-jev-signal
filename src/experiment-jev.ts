import { choice, TypeSafeClient, type JsonValue } from "@typesafe-ai/sdk";
import type {
  Direction,
  ExperimentState,
  Forecast,
  Horizon,
} from "./experiment-types.js";

const CRITERIA = {
  higher: "BTCUSDT spot price at the exact target timestamp is greater than `snapshot.anchor_price_usdt`.",
  lower: "BTCUSDT spot price at the exact target timestamp is less than `snapshot.anchor_price_usdt`.",
} as const;

function directionQuestion(horizon: "15m" | "1h" | "4h") {
  return choice(
    {
      task: `Which ${horizon} BTCUSDT spot-price direction is more probable?`,
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
    task: "Which BTCUSDT spot-price direction is more probable at the end of the current UTC day?",
    reference_price: "Use `snapshot.anchor_price_usdt` at `snapshot.timestamp_utc`.",
    target: "Use the exact timestamp in `targets.end_of_utc_day`.",
    evidence: "Use the observed market state and the three probability distributions in `horizon_forecasts`.",
    missing_data: "Treat null values or fields with available=false as unavailable evidence.",
  },
  CRITERIA,
);

function client(): TypeSafeClient {
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    throw new Error("TYPESAFE_API_KEY is not set. Add it to .env before running the experiment.");
  }
  return new TypeSafeClient({
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
}> {
  const typesafe = client();
  const parallel = await typesafe.systemOne({
    state: state as unknown as Record<string, JsonValue>,
    questions: horizonQuestions,
  });
  const forecasts: Forecast[] = [
    toForecast(
      state,
      "15m",
      state.targets["15m"],
      parallel.answers.direction_15m,
      parallel.model,
      "parallel_horizons",
    ),
    toForecast(
      state,
      "1h",
      state.targets["1h"],
      parallel.answers.direction_1h,
      parallel.model,
      "parallel_horizons",
    ),
    toForecast(
      state,
      "4h",
      state.targets["4h"],
      parallel.answers.direction_4h,
      parallel.model,
      "parallel_horizons",
    ),
  ];

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
  const eod = await typesafe.systemOne({
    state: cascadeState as unknown as Record<string, JsonValue>,
    questions: { direction_eod: eodQuestion },
  });
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

  return {
    forecasts,
    usage: {
      parallel_horizons: parallel.usage,
      eod_cascade: eod.usage,
    },
  };
}
