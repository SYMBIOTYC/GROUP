-- Single-use, request-bound approvals for state-changing compute operations.
-- Approval identity/claims are immutable; only the pending -> consumed/revoked/expired
-- state transition is permitted. Audit events remain append-only via migration 0001.

CREATE TABLE IF NOT EXISTS compute_approvals (
  approval_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
  action TEXT NOT NULL CHECK (action IN ('job.submit', 'job.cancel')),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'revoked', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  target_id TEXT,
  consumed_at TEXT,
  consumed_by_request_id TEXT,
  UNIQUE (tenant_id, project_id, actor_id, action, idempotency_key_hash),
  CHECK (
    (status = 'pending' AND consumed_at IS NULL AND consumed_by_request_id IS NULL) OR
    (status = 'consumed' AND consumed_at IS NOT NULL AND consumed_by_request_id IS NOT NULL) OR
    (status IN ('revoked', 'expired') AND consumed_at IS NULL AND consumed_by_request_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_compute_approvals_actor_status_expiry
  ON compute_approvals (tenant_id, project_id, actor_id, status, expires_at);

CREATE TRIGGER IF NOT EXISTS compute_approvals_claims_immutable
BEFORE UPDATE ON compute_approvals
WHEN NEW.approval_id != OLD.approval_id
  OR NEW.tenant_id != OLD.tenant_id
  OR NEW.project_id != OLD.project_id
  OR NEW.actor_id != OLD.actor_id
  OR NEW.action != OLD.action
  OR NEW.operation_id != OLD.operation_id
  OR NEW.request_hash != OLD.request_hash
  OR NEW.idempotency_key_hash != OLD.idempotency_key_hash
  OR NEW.created_at != OLD.created_at
  OR NEW.expires_at != OLD.expires_at
  OR NEW.target_id IS NOT OLD.target_id
BEGIN
  SELECT RAISE(ABORT, 'compute approval claims are immutable');
END;

CREATE TRIGGER IF NOT EXISTS compute_approvals_state_transition
BEFORE UPDATE ON compute_approvals
WHEN OLD.status != 'pending'
  OR NEW.status NOT IN ('consumed', 'revoked', 'expired')
BEGIN
  SELECT RAISE(ABORT, 'invalid compute approval state transition');
END;

CREATE TRIGGER IF NOT EXISTS compute_approvals_no_delete
BEFORE DELETE ON compute_approvals
BEGIN
  SELECT RAISE(ABORT, 'compute approvals are retained for audit');
END;
