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
