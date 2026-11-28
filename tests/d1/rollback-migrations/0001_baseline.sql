CREATE TABLE migration_baseline (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
INSERT INTO migration_baseline (id, created_at)
VALUES ('baseline', '2026-11-28T00:00:00Z');
