-- Preserve existing reservations while allowing the new single-call paper decision stage.
ALTER TABLE typesafe_request_reservations RENAME TO typesafe_request_reservations_old;

CREATE TABLE typesafe_request_reservations (
  request_key TEXT PRIMARY KEY,
  utc_day TEXT NOT NULL,
  boundary_utc TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('parallel_horizons', 'eod_cascade', 'paper_trade_decision')),
  reserved_at_utc TEXT NOT NULL,
  UNIQUE (boundary_utc, stage)
);

INSERT INTO typesafe_request_reservations (request_key, utc_day, boundary_utc, stage, reserved_at_utc)
SELECT request_key, utc_day, boundary_utc, stage, reserved_at_utc
FROM typesafe_request_reservations_old;

DROP TABLE typesafe_request_reservations_old;

CREATE INDEX typesafe_request_reservations_day_idx
  ON typesafe_request_reservations(utc_day);

CREATE TABLE IF NOT EXISTS paper_trade_scans (
  scan_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  scanned_at_utc TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('candidate_sent', 'no_candidate', 'blocked')),
  reason_code TEXT,
  data_json TEXT NOT NULL
);

CREATE INDEX paper_trade_scans_scanned_idx ON paper_trade_scans(scanned_at_utc);
