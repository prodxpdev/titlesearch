-- The cache and preview-image tables (packages/cache/src/d1.ts creates the
-- same schema on first use; this migration makes it explicit).
CREATE TABLE IF NOT EXISTS titlesearch_cache (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS titlesearch_cache_expires ON titlesearch_cache (expires_at);
CREATE TABLE IF NOT EXISTS titlesearch_blobs (
  key TEXT PRIMARY KEY NOT NULL,
  bytes BLOB NOT NULL,
  content_type TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS titlesearch_blobs_expires ON titlesearch_blobs (expires_at);
