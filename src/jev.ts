import { choice, TypeSafeClient, type JsonValue } from "@typesafe-ai/sdk";
import type { DirectionPrediction, MarketState } from "./types.js";

const directionQuestion = choice(
  {
    task: "Which BTCUSDT spot-price outcome is most probable at the exact target timestamp?",
    reference_price_field: "spot.price_usdt",
    snapshot_timestamp_field: "snapshot.timestamp_utc",
    target_timestamp_field: "snapshot.target_timestamp_utc",
    constraint: "Use only the supplied structured market state. Treat unavailable or null fields as missing data.",
  },
  {
    higher: "BTCUSDT spot price at the target timestamp is greater than spot.price_usdt.",
    lower: "BTCUSDT spot price at the target timestamp is less than spot.price_usdt.",
    unchanged: "BTCUSDT spot price at the target timestamp is exactly equal to spot.price_usdt.",
  } as const,
);

export async function predictDirection(state: MarketState): Promise<DirectionPrediction> {
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    throw new Error(
      "TYPESAFE_API_KEY is not set. Copy .env.example to .env and set the key, or run `npm run snapshot` without Jev.",
    );
  }

  const client = new TypeSafeClient({
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
  const response = await client.systemOne({
    state: state as unknown as Record<string, JsonValue>,
    questions: { btc_spot_direction_60m: directionQuestion },
  });
  const answer = response.answers.btc_spot_direction_60m;

  return {
    model: response.model,
    question: {
      id: "btc_spot_direction_60m",
      horizon_minutes: 60,
      target_timestamp_utc: state.snapshot.target_timestamp_utc,
    },
    answer: {
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
    },
    usage: response.usage,
  };
}
