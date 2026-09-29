import assert from "node:assert/strict";
import test from "node:test";
import { fetchMarketJson, MarketDataRequestError } from "../src/cloudflare-http.js";

const endpoint = new URL("https://api.bybit.com/v5/market/kline");

test("market HTTP 429 stops without retry and preserves retry guidance", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 429, headers: { "Retry-After": "30" } });
  };

  await assert.rejects(fetchMarketJson(endpoint, fetchImpl), (error: unknown) => {
    assert.ok(error instanceof MarketDataRequestError);
    assert.match(error.message, /HTTP 429/);
    assert.match(error.message, /Retry-After=30/);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(calls, 1);
});

test("Bybit retCode 10006 stops without retry", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return Response.json({ retCode: 10006, retMsg: "Too many visits!" }, {
      headers: { "X-Bapi-Limit-Reset-Timestamp": "1790000000000" },
    });
  };

  await assert.rejects(fetchMarketJson(endpoint, fetchImpl), (error: unknown) => {
    assert.ok(error instanceof MarketDataRequestError);
    assert.match(error.message, /rate limit 10006/);
    assert.match(error.message, /Bybit limit reset=/);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(calls, 1);
});

test("a transient HTTP 503 gets one bounded retry", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("unavailable", { status: 503 })
      : Response.json({ retCode: 0, result: { ok: true } });
  };

  assert.deepEqual(await fetchMarketJson<{ retCode: number; result: { ok: boolean } }>(endpoint, fetchImpl), {
    retCode: 0,
    result: { ok: true },
  });
  assert.equal(calls, 2);
});
