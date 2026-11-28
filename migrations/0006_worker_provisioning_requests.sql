-- Durable, subject-scoped idempotency ledger for Provisioner enrollment.
-- The request row, Worker, challenge, audit event and outbox event must be
-- committed in one D1 transaction by the GROUP enrollment boundary.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS worker_provisioning_requests (
  provisioning_request_id TEXT PRIMARY KEY,
  provisioner_subject TEXT NOT NULL
    CHECK (length(provisioner_subject) BETWEEN 1 AND 256),
  idempotency_key_hash TEXT NOT NULL
    CHECK (length(idempotency_key_hash) = 64
      AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
  request_digest TEXT NOT NULL
    CHECK (length(request_digest) = 64
      AND request_digest NOT GLOB '*[^0-9a-f]*'),
  worker_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'COMPLETED')),
  outcome_code TEXT,
  outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
  correlation_id TEXT NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  UNIQUE (provisioner_subject, idempotency_key_hash),
  FOREIGN KEY (worker_id) REFERENCES workers(worker_id),
  CHECK (
    (state = 'PENDING' AND completed_at IS NULL)
    OR
    (state = 'COMPLETED' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS worker_provisioning_requests_expiry
  ON worker_provisioning_requests(state, expires_at);

CREATE INDEX IF NOT EXISTS worker_provisioning_requests_worker
  ON worker_provisioning_requests(worker_id)
  WHERE worker_id IS NOT NULL;


-- Request identity and idempotency claims are immutable for the entire lifetime.
CREATE TRIGGER IF NOT EXISTS worker_provisioning_request_claims_immutable
BEFORE UPDATE ON worker_provisioning_requests
WHEN NEW.provisioning_request_id IS NOT OLD.provisioning_request_id
  OR NEW.provisioner_subject IS NOT OLD.provisioner_subject
  OR NEW.idempotency_key_hash IS NOT OLD.idempotency_key_hash
  OR NEW.request_digest IS NOT OLD.request_digest
  OR NEW.correlation_id IS NOT OLD.correlation_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'provisioning request claims are immutable');
END;

-- Only one complete transition is allowed: PENDING -> COMPLETED.
-- Completion must contain a Worker, outcome, and completion timestamp.
CREATE TRIGGER IF NOT EXISTS worker_provisioning_request_transition_guard
BEFORE UPDATE ON worker_provisioning_requests
WHEN NOT (
  OLD.state = 'PENDING'
  AND NEW.state = 'COMPLETED'
  AND NEW.worker_id IS NOT NULL
  AND NEW.outcome_code IS NOT NULL
  AND length(NEW.outcome_code) BETWEEN 1 AND 128
  AND NEW.outcome_json IS NOT NULL
  AND NEW.completed_at IS NOT NULL
  AND NEW.updated_at IS NOT OLD.updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'invalid provisioning request state transition');
END;

CREATE TRIGGER IF NOT EXISTS worker_provisioning_request_completed_no_update
BEFORE UPDATE ON worker_provisioning_requests
WHEN OLD.state = 'COMPLETED'
BEGIN
  SELECT RAISE(ABORT, 'completed provisioning requests are immutable');
END;

CREATE TRIGGER IF NOT EXISTS worker_provisioning_request_no_delete
BEFORE DELETE ON worker_provisioning_requests
BEGIN
  SELECT RAISE(ABORT, 'provisioning request ledger is append-only');
END;
