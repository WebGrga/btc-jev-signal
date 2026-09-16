const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 10_000;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchJson<T>(
  url: URL,
  options: { retries?: number; timeoutMs?: number } = {},
): Promise<T> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "btc-jev-signal/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 300);
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        throw new HttpError(
          `GET ${url.host}${url.pathname} returned ${response.status}: ${body}`,
          response.status,
          retryAfterMs,
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      const retryable =
        !(error instanceof HttpError) ||
        error.status === 408 ||
        error.status === 429 ||
        error.status >= 500;
      if (!retryable || attempt === retries) break;
      const exponentialMs = Math.min(500 * 2 ** attempt, 5_000);
      const jitteredMs = exponentialMs * (0.75 + Math.random() * 0.25);
      const retryAfterMs = error instanceof HttpError ? error.retryAfterMs : null;
      await delay(Math.min(retryAfterMs ?? jitteredMs, 60_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/apikey_[A-Za-z0-9_]+/gi, "[redacted]");
  return String(error).replace(/apikey_[A-Za-z0-9_]+/gi, "[redacted]");
}
