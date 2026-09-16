CREATE TABLE IF NOT EXISTS prediction_batches (
  batch_id TEXT PRIMARY KEY,
  snapshot_utc TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS prediction_batches_snapshot_idx
  ON prediction_batches(snapshot_utc);

CREATE TABLE IF NOT EXISTS settlements (
  forecast_id TEXT PRIMARY KEY,
  horizon TEXT NOT NULL,
  target_utc TEXT NOT NULL,
  settled_at_utc TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS settlements_target_idx
  ON settlements(target_utc);
