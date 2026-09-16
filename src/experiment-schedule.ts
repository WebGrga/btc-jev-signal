import type { Forecast, Horizon } from "./experiment-types.js";

export const HORIZON_ORDER: readonly Horizon[] = ["15m", "1h", "4h", "eod"];

export const HORIZON_SCHEDULE = {
  "15m": { issue_every_minutes: 15, expected_per_utc_day: 96 },
  "1h": { issue_every_minutes: 60, expected_per_utc_day: 24 },
  "4h": { issue_every_minutes: 240, expected_per_utc_day: 6 },
  eod: { issue_every_minutes: 1440, expected_per_utc_day: 1 },
} as const;

export function horizonsDueAt(boundaryMs: number): Horizon[] {
  const date = new Date(boundaryMs);
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  if (
    date.getUTCSeconds() !== 0 ||
    date.getUTCMilliseconds() !== 0 ||
    minute % 15 !== 0
  ) return [];
  const result: Horizon[] = ["15m"];
  if (minute === 0) result.push("1h");
  if (minute === 0 && hour % 4 === 0) result.push("4h");
  if (minute === 0 && hour === 0) result.push("eod");
  return result;
}

export function isPrimaryForecast(forecast: Forecast): boolean {
  const issued = Date.parse(forecast.origin_timestamp_utc);
  if (!Number.isFinite(issued)) return false;
  return horizonsDueAt(issued).includes(forecast.horizon);
}
