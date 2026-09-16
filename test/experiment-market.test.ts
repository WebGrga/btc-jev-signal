import assert from "node:assert/strict";
import test from "node:test";
import { expectedCandleCloseMs } from "../src/experiment-market.js";

test("expected candle closes align correctly at mixed timeframe boundaries", () => {
  const sevenUtc = Date.parse("2026-09-16T07:00:00.000Z");
  const sevenFifteenUtc = Date.parse("2026-09-16T07:15:00.000Z");
  assert.equal(expectedCandleCloseMs("1m", sevenUtc), sevenUtc - 1);
  assert.equal(expectedCandleCloseMs("15m", sevenUtc), sevenUtc - 1);
  assert.equal(expectedCandleCloseMs("1h", sevenUtc), sevenUtc - 1);
  assert.equal(
    expectedCandleCloseMs("1h", sevenFifteenUtc),
    Date.parse("2026-09-16T06:59:59.999Z"),
  );
  assert.equal(
    expectedCandleCloseMs("4h", sevenFifteenUtc),
    Date.parse("2026-09-16T03:59:59.999Z"),
  );
});
