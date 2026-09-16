/// <reference types="@cloudflare/workers-types" />

import type { PredictionBatch, Settlement } from "./experiment-types.js";

interface JsonRow { data_json: string }

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
