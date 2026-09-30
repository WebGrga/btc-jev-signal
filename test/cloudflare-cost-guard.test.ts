/// <reference types="@cloudflare/workers-types" />

import assert from "node:assert/strict";
import test from "node:test";
import type { PaperTradePosition } from "../src/paper-simulator.js";
import {
  DEFAULT_TYPESAFE_DAILY_REQUEST_LIMIT,
  parseTypesafeDailyRequestLimit,
  typesafeRequestKey,
  utcDay,
} from "../src/cloudflare-cost-guard.js";
import {
  appendCloudflarePaperTradeScan,
  hasActivePaperTrade,
  saveCloudflarePaperTrade,
  claimScheduledBoundary,
  countTypesafeRequests,
  isCollectionPaused,
  reserveTypesafeRequest,
  updateScheduledBoundary,
} from "../src/cloudflare-store.js";

interface ReservationRow {
  request_key: string;
  utc_day: string;
  boundary_utc: string;
  stage: string;
  reserved_at_utc: string;
}

interface PaperScanRow { data_json: string }

class MemoryStatement {
  private values: unknown[] = [];

  constructor(private readonly database: MemoryD1, private readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async run<T>(): Promise<D1Result<T>> {
    let changes = 0;
    if (this.sql.includes("INSERT OR IGNORE INTO scheduled_runs")) {
      const [boundary] = this.values as [string];
      if (!this.database.scheduled.has(boundary)) {
        this.database.scheduled.set(boundary, { status: "started" });
        changes = 1;
      }
    } else if (this.sql.includes("INSERT OR IGNORE INTO paper_trade_scans")) {
      const [scanId, snapshotId, scannedAt, outcome, reason, data] = this.values as [string, string, string, string, string | null, string];
      if (!this.database.paperScans.has(scanId)) {
        this.database.paperScans.set(scanId, { snapshot_id: snapshotId, scanned_at_utc: scannedAt, outcome, reason_code: reason, data_json: data });
        changes = 1;
      }
    } else if (this.sql.includes("INSERT INTO paper_trade_positions")) {
      const [tradeId, proposalId, symbol, status, createdAt, updatedAt, data] = this.values as [string, string, string, string, string, string, string];
      const previous = this.database.paperPositions.get(tradeId);
      if (!previous || (["pending_entry", "open"].includes(previous.status) && updatedAt >= previous.updated_at_utc)) {
        this.database.paperPositions.set(tradeId, { proposal_id: proposalId, symbol, status, created_at_utc: createdAt, updated_at_utc: updatedAt, data_json: data });
        changes = 1;
      }
    } else if (this.sql.includes("UPDATE scheduled_runs")) {
      const [status, , , , , boundary] = this.values as [string, number, number, string | null, string, string];
      const row = this.database.scheduled.get(boundary);
      if (row) row.status = status;
      changes = row ? 1 : 0;
    } else if (this.sql.includes("INSERT OR IGNORE INTO typesafe_request_reservations")) {
      const [key, day, boundary, stage, reservedAt, countDay, limit] = this.values as [string, string, string, string, string, string, number];
      const duplicate = this.database.reservations.has(key);
      const count = [...this.database.reservations.values()].filter((row) => row.utc_day === countDay).length;
      if (!duplicate && count < limit) {
        this.database.reservations.set(key, { request_key: key, utc_day: day, boundary_utc: boundary, stage, reserved_at_utc: reservedAt });
        changes = 1;
      }
    } else {
      throw new Error(`Unexpected SQL in test fake: ${this.sql}`);
    }
    return { success: true, meta: { changes }, results: [] } as unknown as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("COUNT(*) AS request_count")) {
      const [day] = this.values as [string];
      const request_count = [...this.database.reservations.values()].filter((row) => row.utc_day === day).length;
      return { request_count } as T;
    }
    if (this.sql.includes("SELECT paused FROM experiment_control")) {
      return this.database.paused === null ? null : { paused: this.database.paused } as T;
    }
    if (this.sql.includes("SELECT trade_id FROM paper_trade_positions")) {
      const [symbol] = this.values as [string];
      const row = [...this.database.paperPositions.entries()].find(([, position]) => position.symbol === symbol && ["pending_entry", "open"].includes(position.status));
      return row ? { trade_id: row[0] } as T : null;
    }
    if (this.sql.includes("SELECT request_key FROM typesafe_request_reservations")) {
      const [key] = this.values as [string];
      const row = this.database.reservations.get(key);
      return row ? { request_key: row.request_key } as T : null;
    }
    throw new Error(`Unexpected SQL in test fake: ${this.sql}`);
  }
}

class MemoryD1 {
  readonly reservations = new Map<string, ReservationRow>();
  readonly scheduled = new Map<string, { status: string }>();
  readonly paperScans = new Map<string, { snapshot_id: string; scanned_at_utc: string; outcome: string; reason_code: string | null; data_json: string }>();
  readonly paperPositions = new Map<string, { proposal_id: string; symbol: string; status: string; created_at_utc: string; updated_at_utc: string; data_json: string }>();
  paused: 0 | 1 | null = 0;

  prepare(sql: string): MemoryStatement {
    return new MemoryStatement(this, sql);
  }
}

const utcDayValue = "2026-09-29";
const boundary = "2026-09-29T12:00:00.000Z";

test("daily TypeSafe request limit defaults to the scheduled maximum and rejects invalid values", () => {
  assert.equal(DEFAULT_TYPESAFE_DAILY_REQUEST_LIMIT, 97);
  assert.equal(parseTypesafeDailyRequestLimit(undefined), 97);
  assert.equal(parseTypesafeDailyRequestLimit("1"), 1);
  assert.equal(parseTypesafeDailyRequestLimit("10000"), 10_000);
  for (const value of ["0", "-1", "1.5", "wat", "10001"]) {
    assert.throws(() => parseTypesafeDailyRequestLimit(value), /whole number/);
  }
});

test("UTC day and idempotency keys are stable across repeated schedule delivery", () => {
  assert.equal(utcDay(new Date("2026-09-29T23:59:59.000Z")), "2026-09-29");
  assert.equal(typesafeRequestKey(boundary, "parallel_horizons"), `${boundary}:parallel_horizons`);
});

test("D1 request reservations enforce a concurrent daily cap and make retries idempotent", async () => {
  const db = new MemoryD1() as unknown as D1Database;
  const results = await Promise.all([
    reserveTypesafeRequest(db, boundary, "parallel_horizons", utcDayValue, `${boundary}`, 1),
    reserveTypesafeRequest(db, "2026-09-29T12:15:00.000Z", "parallel_horizons", utcDayValue, `${boundary}`, 1),
  ]);
  assert.equal(results.filter((result) => result.allowed).length, 1);
  assert.equal(results.filter((result) => result.reason === "daily_limit").length, 1);
  assert.equal(await countTypesafeRequests(db, utcDayValue), 1);

  const retry = await reserveTypesafeRequest(db, boundary, "parallel_horizons", utcDayValue, `${boundary}`, 1);
  assert.equal(retry.allowed, false);
  assert.equal(retry.reason, "duplicate");
  assert.equal(await countTypesafeRequests(db, utcDayValue), 1);
});

test("scheduled boundary claims deduplicate Cron delivery and persist pause state", async () => {
  const memory = new MemoryD1();
  const db = memory as unknown as D1Database;
  assert.equal(await claimScheduledBoundary(db, boundary, boundary), true);
  assert.equal(await claimScheduledBoundary(db, boundary, boundary), false);
  await updateScheduledBoundary(db, boundary, "paused", 3, 97, "operator_pause", boundary);
  assert.equal(memory.scheduled.get(boundary)?.status, "paused");
  assert.equal(await isCollectionPaused(db), false);
  memory.paused = 1;
  assert.equal(await isCollectionPaused(db), true);
  memory.paused = null;
  await assert.rejects(isCollectionPaused(db), /missing or invalid/);
});

test("D1 paper scans are idempotent by immutable scan id", async () => {
  const db = new MemoryD1() as unknown as D1Database;
  const scan = {
    scan_id: "scan:BTCUSD:2026-09-29T12:00:00.000Z:2.0.0:atr_cost_event_v1",
    snapshot_id: "BTCUSD:2026-09-29T12:00:00.000Z:2.0.0",
    scanned_at_utc: "2026-09-29T12:00:05.000Z",
    outcome: "no_candidate",
    reason_code: "move_below_estimated_cost",
  } as never;
  assert.equal(await appendCloudflarePaperTradeScan(db, scan), true);
  assert.equal(await appendCloudflarePaperTradeScan(db, scan), false);
});

test("D1 allows one active paper position per symbol and closes its active slot", async () => {
  const db = new MemoryD1() as unknown as D1Database;
  const position = {
    trade_id: "paper:proposal-one",
    proposal_id: "proposal-one",
    symbol: "BTCUSD",
    status: "pending_entry",
    created_at_utc: "2026-09-29T12:00:00.000Z",
    updated_at_utc: "2026-09-29T12:00:00.000Z",
  } as unknown as PaperTradePosition;
  await saveCloudflarePaperTrade(db, position);
  assert.equal(await hasActivePaperTrade(db, "BTCUSD"), true);
  await saveCloudflarePaperTrade(db, { ...position, status: "closed", updated_at_utc: "2026-09-29T16:00:00.000Z" });
  assert.equal(await hasActivePaperTrade(db, "BTCUSD"), false);
});
