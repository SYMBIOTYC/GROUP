-- Durable Tool/Skill Runtime ledger. This migration adds metadata-only audit
-- and tenant-scoped idempotency without changing existing Job API tables.

CREATE TABLE IF NOT EXISTS runtime_idempotency (
  namespace TEXT NOT NULL CHECK (namespace IN ('tool', 'skill')),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 256),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'succeeded', 'unknown', 'failed')),
  result_json TEXT CHECK (result_json IS NULL OR length(result_json) <= 65536),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_runtime_idempotency_status
  ON runtime_idempotency(namespace, status, updated_at);

CREATE TABLE IF NOT EXISTS runtime_audit_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  request_id TEXT,
  run_id TEXT,
  tool_id TEXT,
  invocation_id TEXT,
  skill_id TEXT,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  side_effect TEXT,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  step_count INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json))
);

CREATE INDEX IF NOT EXISTS idx_runtime_audit_tenant_created
  ON runtime_audit_events(tenant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_runtime_audit_request
  ON runtime_audit_events(request_id);

CREATE INDEX IF NOT EXISTS idx_runtime_audit_run
  ON runtime_audit_events(run_id);

CREATE TRIGGER IF NOT EXISTS runtime_audit_events_no_update
BEFORE UPDATE ON runtime_audit_events
BEGIN
  SELECT RAISE(ABORT, 'runtime audit events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS runtime_audit_events_no_delete
BEFORE DELETE ON runtime_audit_events
BEGIN
  SELECT RAISE(ABORT, 'runtime audit events are append-only');
END;
