CREATE TABLE IF NOT EXISTS paper_trade_positions (
  trade_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_entry', 'open', 'closed', 'skipped', 'unpriceable')),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE INDEX paper_trade_positions_status_symbol_idx
  ON paper_trade_positions(status, symbol);

CREATE UNIQUE INDEX one_active_paper_trade_per_symbol_idx
  ON paper_trade_positions(symbol)
  WHERE status IN ('pending_entry', 'open');

CREATE INDEX paper_trade_positions_updated_idx
  ON paper_trade_positions(updated_at_utc);
