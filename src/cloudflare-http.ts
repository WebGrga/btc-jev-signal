export class MarketDataRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MarketDataRequestError";
  }
}

const MAX_REQUEST_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;

function rateLimitDetails(response: Response): string {
  const details: string[] = [];
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) details.push(`Retry-After=${retryAfter}`);
  const resetAt = response.headers.get("X-Bapi-Limit-Reset-Timestamp");
  if (resetAt) {
    const resetMs = Number(resetAt);
    details.push(Number.isFinite(resetMs) ? `Bybit limit reset=${new Date(resetMs).toISOString()}` : `Bybit limit reset=${resetAt}`);
  }
  return details.length ? ` (${details.join(", ")})` : "";
}

function isBybitRateLimit(value: unknown): value is { retCode: number; retMsg?: string } {
  if (!value || typeof value !== "object") return false;
  const response = value as { retCode?: unknown; retMsg?: unknown };
  return typeof response.retCode === "number" && response.retCode !== 0 &&
    (response.retCode === 10006 || response.retCode === 10018);
}

export async function fetchMarketJson<T>(input: URL, fetchImpl: typeof fetch = fetch): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(input, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      lastError = new MarketDataRequestError(
        `${input.host}${input.pathname} request failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
        { cause: error },
      );
      if (attempt + 1 < MAX_REQUEST_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      break;
    }

    if (!response.ok) {
      const rateLimited = response.status === 429 || response.status === 403;
      const retryable = !rateLimited && (response.status === 408 || response.status >= 500);
      lastError = new MarketDataRequestError(
        `${input.host}${input.pathname} returned HTTP ${response.status}${rateLimited ? rateLimitDetails(response) : ""}`,
        retryable,
      );
      if (retryable && attempt + 1 < MAX_REQUEST_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      break;
    }

    try {
      const body = await response.json() as T;
      if (isBybitRateLimit(body)) {
        throw new MarketDataRequestError(
          `Bybit rate limit ${body.retCode}: ${body.retMsg ?? "too many requests"}${rateLimitDetails(response)}`,
          false,
        );
      }
      return body;
    } catch (error) {
      if (error instanceof MarketDataRequestError) throw error;
      throw new MarketDataRequestError(
        `${input.host}${input.pathname} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        false,
        { cause: error },
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
