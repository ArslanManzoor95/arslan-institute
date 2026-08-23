-- Apply with:
--   wrangler d1 execute pressroom-inbox --remote --file capture/worker/schema.sql
CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  -- Tracking parameters stripped, so re-saving the same link is a no-op.
  canonical_url TEXT NOT NULL UNIQUE,
  title         TEXT,
  note          TEXT,
  tags          TEXT,
  kind          TEXT,
  author        TEXT,
  site_name     TEXT,
  saved_at      TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_saved_at ON items (saved_at);
