CREATE TABLE IF NOT EXISTS experiment_control (
  control_id TEXT PRIMARY KEY CHECK (control_id = 'collection'),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  updated_at_utc TEXT NOT NULL
);

INSERT OR IGNORE INTO experiment_control (control_id, paused, updated_at_utc)
VALUES ('collection', 0, '1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS scheduled_runs (
  boundary_utc TEXT PRIMARY KEY,
  started_at_utc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'paused', 'completed', 'limit_reached', 'failed')),
  requests_used INTEGER NOT NULL DEFAULT 0,
  request_limit INTEGER NOT NULL DEFAULT 0,
  skipped_reason TEXT,
  updated_at_utc TEXT
);

CREATE TABLE IF NOT EXISTS typesafe_request_reservations (
  request_key TEXT PRIMARY KEY,
  utc_day TEXT NOT NULL,
  boundary_utc TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('parallel_horizons', 'eod_cascade')),
  reserved_at_utc TEXT NOT NULL,
  UNIQUE (boundary_utc, stage)
);

CREATE INDEX IF NOT EXISTS typesafe_request_reservations_day_idx
  ON typesafe_request_reservations(utc_day);
