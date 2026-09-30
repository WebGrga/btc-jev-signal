export const DEFAULT_TYPESAFE_DAILY_REQUEST_LIMIT = 97;
export const MAX_TYPESAFE_DAILY_REQUEST_LIMIT = 10_000;

export type TypeSafeRequestStage = "parallel_horizons" | "eod_cascade" | "paper_trade_decision";

export function parseTypesafeDailyRequestLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_TYPESAFE_DAILY_REQUEST_LIMIT;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("TYPESAFE_DAILY_REQUEST_LIMIT must be a whole number between 1 and 10000.");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TYPESAFE_DAILY_REQUEST_LIMIT) {
    throw new Error("TYPESAFE_DAILY_REQUEST_LIMIT must be a whole number between 1 and 10000.");
  }
  return limit;
}

export function utcDay(timestamp = new Date()): string {
  return timestamp.toISOString().slice(0, 10);
}

export function typesafeRequestKey(boundaryUtc: string, stage: TypeSafeRequestStage): string {
  return `${boundaryUtc}:${stage}`;
}
