PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS project_quotas (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  active_jobs INTEGER NOT NULL DEFAULT 0 CHECK (active_jobs >= 0),
  max_active_jobs INTEGER NOT NULL CHECK (max_active_jobs >= 1),
  max_cpu_millis_per_job INTEGER NOT NULL CHECK (max_cpu_millis_per_job >= 1),
  max_memory_mib_per_job INTEGER NOT NULL CHECK (max_memory_mib_per_job >= 16),
  max_timeout_seconds INTEGER NOT NULL CHECK (max_timeout_seconds >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id)
);

CREATE TABLE IF NOT EXISTS project_operation_policies (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  max_cpu_millis_per_job INTEGER NOT NULL CHECK (max_cpu_millis_per_job >= 1),
  max_memory_mib_per_job INTEGER NOT NULL CHECK (max_memory_mib_per_job >= 16),
  max_timeout_seconds INTEGER NOT NULL CHECK (max_timeout_seconds >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id, operation_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES project_quotas(tenant_id, project_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  output_policy_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('QUEUED', 'SCHEDULED', 'DISPATCHED', 'RUNNING', 'CANCEL_REQUESTED', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  record_version INTEGER NOT NULL DEFAULT 1 CHECK (record_version >= 1),
  request_digest TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deadline_at TEXT,
  FOREIGN KEY (tenant_id, project_id) REFERENCES project_quotas(tenant_id, project_id)
);

CREATE INDEX IF NOT EXISTS jobs_tenant_project_state_created
  ON jobs (tenant_id, project_id, state, created_at);

CREATE TABLE IF NOT EXISTS idempotency_records (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  job_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id, operation_id, idempotency_key_hash),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id)
);

CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  worker_id TEXT,
  lease_epoch INTEGER,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, attempt_number),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  request_digest TEXT,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_tenant_project_created
  ON audit_events (tenant_id, project_id, created_at);

CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS outbox_unpublished
  ON outbox_events (published_at, created_at);

CREATE TRIGGER IF NOT EXISTS jobs_release_quota_on_terminal
AFTER UPDATE OF state ON jobs
WHEN OLD.state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
 AND NEW.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
BEGIN
  UPDATE project_quotas
  SET active_jobs = CASE WHEN active_jobs > 0 THEN active_jobs - 1 ELSE 0 END,
      updated_at = NEW.updated_at
  WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
END;
