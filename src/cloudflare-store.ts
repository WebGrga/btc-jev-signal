/// <reference types="@cloudflare/workers-types" />

import type { PaperTradeScan } from "./paper-trade.js";
import type { PaperTradePosition } from "./paper-simulator.js";
import type { PredictionBatch, Settlement } from "./experiment-types.js";
import { typesafeRequestKey, type TypeSafeRequestStage } from "./cloudflare-cost-guard.js";

interface JsonRow { data_json: string }
interface CountRow { request_count: number }
interface PauseRow { paused: number }

export interface TypeSafeReservation {
  allowed: boolean;
  reason: "reserved" | "duplicate" | "daily_limit";
  requests_used: number;
}

function parseRows<T>(rows: readonly JsonRow[]): T[] {
  return rows.map((row) => JSON.parse(row.data_json) as T);
}

export async function loadCloudflareBatches(db: D1Database): Promise<PredictionBatch[]> {
  const result = await db.prepare(
    "SELECT data_json FROM prediction_batches ORDER BY snapshot_utc ASC LIMIT 10000",
  ).all<JsonRow>();
  return parseRows<PredictionBatch>(result.results);
}

export async function loadCloudflareSettlements(db: D1Database): Promise<Settlement[]> {
  const result = await db.prepare(
    "SELECT data_json FROM settlements ORDER BY target_utc ASC LIMIT 50000",
  ).all<JsonRow>();
  return parseRows<Settlement>(result.results);
}

export async function appendCloudflareBatch(db: D1Database, batch: PredictionBatch): Promise<boolean> {
  const result = await db.prepare(
    "INSERT OR IGNORE INTO prediction_batches (batch_id, snapshot_utc, created_at_utc, data_json) VALUES (?, ?, ?, ?)",
  ).bind(batch.batch_id, batch.state.snapshot.timestamp_utc, batch.created_at_utc, JSON.stringify(batch)).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function appendCloudflareSettlement(db: D1Database, settlement: Settlement): Promise<boolean> {
  const result = await db.prepare(
    "INSERT OR IGNORE INTO settlements (forecast_id, horizon, target_utc, settled_at_utc, data_json) VALUES (?, ?, ?, ?, ?)",
  ).bind(settlement.forecast_id, settlement.horizon, settlement.target_timestamp_utc, settlement.settled_at_utc, JSON.stringify(settlement)).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function hasCloudflarePaperTradeScan(db: D1Database, scanId: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT scan_id FROM paper_trade_scans WHERE scan_id = ?",
  ).bind(scanId).first<{ scan_id: string }>();
  return row !== null;
}

export async function appendCloudflarePaperTradeScan(db: D1Database, scan: PaperTradeScan): Promise<boolean> {
  const result = await db.prepare(
    "INSERT OR IGNORE INTO paper_trade_scans (scan_id, snapshot_id, scanned_at_utc, outcome, reason_code, data_json) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(scan.scan_id, scan.snapshot_id, scan.scanned_at_utc, scan.outcome, scan.reason_code, JSON.stringify(scan)).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function loadCloudflarePaperTradeScans(db: D1Database): Promise<PaperTradeScan[]> {
  const [proposalRows, recentRows] = await Promise.all([
    db.prepare("SELECT data_json FROM paper_trade_scans WHERE outcome = 'candidate_sent' ORDER BY scanned_at_utc DESC LIMIT 1000").all<JsonRow>(),
    db.prepare("SELECT data_json FROM paper_trade_scans ORDER BY scanned_at_utc DESC LIMIT 50").all<JsonRow>(),
  ]);
  const unique = new Map<string, PaperTradeScan>();
  for (const scan of [...proposalRows.results, ...recentRows.results].map((row) => JSON.parse(row.data_json) as PaperTradeScan)) unique.set(scan.scan_id, scan);
  return [...unique.values()];
}

export async function hasActivePaperTrade(db: D1Database, symbol: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT trade_id FROM paper_trade_positions WHERE symbol = ? AND status IN ('pending_entry', 'open') LIMIT 1",
  ).bind(symbol).first<{ trade_id: string }>();
  return row !== null;
}

export async function loadActivePaperTrades(db: D1Database): Promise<PaperTradePosition[]> {
  const result = await db.prepare(
    "SELECT data_json FROM paper_trade_positions WHERE status IN ('pending_entry', 'open') ORDER BY created_at_utc ASC LIMIT 100",
  ).all<JsonRow>();
  return parseRows<PaperTradePosition>(result.results);
}

export async function loadCloudflarePaperTrades(db: D1Database): Promise<PaperTradePosition[]> {
  const result = await db.prepare(
    "SELECT data_json FROM paper_trade_positions ORDER BY created_at_utc DESC LIMIT 1000",
  ).all<JsonRow>();
  return parseRows<PaperTradePosition>(result.results);
}

export async function saveCloudflarePaperTrade(db: D1Database, position: PaperTradePosition): Promise<void> {
  await db.prepare(
    `INSERT INTO paper_trade_positions
      (trade_id, proposal_id, symbol, status, created_at_utc, updated_at_utc, data_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(trade_id) DO UPDATE SET
      status = excluded.status,
      updated_at_utc = excluded.updated_at_utc,
      data_json = excluded.data_json
     WHERE paper_trade_positions.status IN ('pending_entry', 'open')
       AND excluded.updated_at_utc >= paper_trade_positions.updated_at_utc`,
  ).bind(position.trade_id, position.proposal_id, position.symbol, position.status, position.created_at_utc, position.updated_at_utc, JSON.stringify(position)).run();
}

export async function isCollectionPaused(db: D1Database): Promise<boolean> {
  const row = await db.prepare(
    "SELECT paused FROM experiment_control WHERE control_id = 'collection'",
  ).first<PauseRow>();
  if (!row || (row.paused !== 0 && row.paused !== 1)) {
    throw new Error("Cloudflare experiment control is missing or invalid; scheduled collection is stopped.");
  }
  return row.paused === 1;
}

export async function claimScheduledBoundary(db: D1Database, boundaryUtc: string, nowUtc: string): Promise<boolean> {
  const result = await db.prepare(
    "INSERT OR IGNORE INTO scheduled_runs (boundary_utc, started_at_utc, status) VALUES (?, ?, 'started')",
  ).bind(boundaryUtc, nowUtc).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updateScheduledBoundary(
  db: D1Database,
  boundaryUtc: string,
  status: "paused" | "completed" | "limit_reached" | "failed",
  requestsUsed: number,
  requestLimit: number,
  skippedReason: string | null,
  updatedAtUtc: string,
): Promise<void> {
  await db.prepare(
    "UPDATE scheduled_runs SET status = ?, requests_used = ?, request_limit = ?, skipped_reason = ?, updated_at_utc = ? WHERE boundary_utc = ?",
  ).bind(status, requestsUsed, requestLimit, skippedReason, updatedAtUtc, boundaryUtc).run();
}

export async function countTypesafeRequests(db: D1Database, utcDay: string): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS request_count FROM typesafe_request_reservations WHERE utc_day = ?",
  ).bind(utcDay).first<CountRow>();
  return row?.request_count ?? 0;
}

export async function reserveTypesafeRequest(
  db: D1Database,
  boundaryUtc: string,
  stage: TypeSafeRequestStage,
  utcDay: string,
  nowUtc: string,
  requestLimit: number,
): Promise<TypeSafeReservation> {
  const requestKey = typesafeRequestKey(boundaryUtc, stage);
  const result = await db.prepare(
    `INSERT OR IGNORE INTO typesafe_request_reservations
      (request_key, utc_day, boundary_utc, stage, reserved_at_utc)
     SELECT ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM typesafe_request_reservations WHERE utc_day = ?) < ?`,
  ).bind(requestKey, utcDay, boundaryUtc, stage, nowUtc, utcDay, requestLimit).run();
  const requestsUsed = await countTypesafeRequests(db, utcDay);
  if ((result.meta.changes ?? 0) > 0) {
    return { allowed: true, reason: "reserved", requests_used: requestsUsed };
  }

  const existing = await db.prepare(
    "SELECT request_key FROM typesafe_request_reservations WHERE request_key = ?",
  ).bind(requestKey).first<{ request_key: string }>();
  return {
    allowed: false,
    reason: existing ? "duplicate" : "daily_limit",
    requests_used: requestsUsed,
  };
}

