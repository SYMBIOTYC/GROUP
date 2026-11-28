-- Durable Worker Registry foundation. This migration creates storage only;
-- it intentionally does not expose registration or heartbeat HTTP routes.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workers (
  worker_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  pool_id TEXT NOT NULL CHECK (length(pool_id) BETWEEN 1 AND 128),
  provisioner_subject TEXT NOT NULL CHECK (length(provisioner_subject) BETWEEN 1 AND 256),
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare', 'deno', 'fly', 'linux_host', 'other')),
  provider_resource_id TEXT,
  region TEXT NOT NULL CHECK (length(region) BETWEEN 1 AND 128),
  worker_class TEXT NOT NULL CHECK (worker_class IN ('cpu', 'vps', 'gpu', 'edge', 'specialized')),
  trust_class TEXT NOT NULL CHECK (trust_class IN ('ephemeral_ci', 'persistent', 'isolated')),
  state TEXT NOT NULL CHECK (state IN ('PENDING_ENROLLMENT', 'ACTIVE', 'DEGRADED', 'DRAINING', 'OFFLINE', 'REVOKED')),
  registration_epoch INTEGER NOT NULL DEFAULT 1 CHECK (registration_epoch >= 1),
  heartbeat_sequence INTEGER NOT NULL DEFAULT 0 CHECK (heartbeat_sequence >= 0),
  lease_expires_at TEXT,
  capacity_max_concurrency INTEGER NOT NULL CHECK (capacity_max_concurrency BETWEEN 1 AND 4096),
  capacity_cpu_millis INTEGER NOT NULL CHECK (capacity_cpu_millis BETWEEN 1 AND 1048576),
  capacity_memory_bytes INTEGER NOT NULL CHECK (capacity_memory_bytes >= 16777216),
  capacity_disk_bytes INTEGER NOT NULL CHECK (capacity_disk_bytes >= 0),
  last_heartbeat_at TEXT,
  drain_requested_at TEXT,
  revoked_at TEXT,
  record_version INTEGER NOT NULL DEFAULT 1 CHECK (record_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, project_id) REFERENCES project_quotas(tenant_id, project_id),
  UNIQUE (worker_id, tenant_id, project_id)
);

CREATE INDEX IF NOT EXISTS workers_pool_state_lease
  ON workers (tenant_id, project_id, pool_id, state, lease_expires_at);

CREATE INDEX IF NOT EXISTS workers_lease_expiry
  ON workers (state, lease_expires_at)
  WHERE state IN ('ACTIVE', 'DEGRADED');

CREATE TABLE IF NOT EXISTS worker_capabilities (
  worker_id TEXT NOT NULL,
  capability_id TEXT NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 128),
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (worker_id, capability_id),
  FOREIGN KEY (worker_id) REFERENCES workers(worker_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS worker_enrollment_challenges (
  challenge_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  challenge_hash TEXT NOT NULL UNIQUE CHECK (length(challenge_hash) = 64),
  provisioner_subject TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  FOREIGN KEY (worker_id) REFERENCES workers(worker_id) ON DELETE CASCADE,
  CHECK (consumed_at IS NULL OR superseded_at IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS worker_one_unconsumed_challenge
  ON worker_enrollment_challenges(worker_id)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS worker_challenge_expiry
  ON worker_enrollment_challenges(expires_at)
  WHERE consumed_at IS NULL;


-- Explicitly supersede expired, unconsumed challenges before enforcing the
-- one-live-challenge-per-Worker partial unique index. consumed_at remains
-- reserved for successful proof redemption.
CREATE TRIGGER IF NOT EXISTS worker_supersede_expired_challenge
BEFORE INSERT ON worker_enrollment_challenges
BEGIN
  UPDATE worker_enrollment_challenges
  SET superseded_at = NEW.created_at
  WHERE worker_id = NEW.worker_id
    AND consumed_at IS NULL
    AND superseded_at IS NULL
    AND expires_at <= NEW.created_at;
END;

CREATE TABLE IF NOT EXISTS worker_credentials (
  credential_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  registration_epoch INTEGER NOT NULL CHECK (registration_epoch >= 1),
  token_jti TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  signing_key_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (worker_id) REFERENCES workers(worker_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS worker_credentials_current
  ON worker_credentials(worker_id, registration_epoch, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT NOT NULL,
  heartbeat_sequence INTEGER NOT NULL CHECK (heartbeat_sequence >= 1),
  registration_epoch INTEGER NOT NULL CHECK (registration_epoch >= 1),
  health_state TEXT NOT NULL CHECK (health_state IN ('healthy', 'degraded')),
  observed_concurrency INTEGER NOT NULL CHECK (observed_concurrency >= 0),
  observed_cpu_millis INTEGER NOT NULL CHECK (observed_cpu_millis >= 0),
  observed_memory_bytes INTEGER NOT NULL CHECK (observed_memory_bytes >= 0),
  received_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  PRIMARY KEY (worker_id, heartbeat_sequence),
  FOREIGN KEY (worker_id) REFERENCES workers(worker_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS worker_heartbeats_received
  ON worker_heartbeats(worker_id, received_at);

CREATE TABLE IF NOT EXISTS worker_audit_events (
  event_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'WORKER_ENROLLED', 'CREDENTIAL_ISSUED', 'CREDENTIAL_REVOKED',
    'HEARTBEAT_ACCEPTED', 'WORKER_DRAIN_REQUESTED', 'WORKER_DRAINED',
    'WORKER_OFFLINE', 'WORKER_REVOKED', 'WORKER_CAPABILITY_GRANTED'
  )),
  record_version INTEGER NOT NULL CHECK (record_version >= 1),
  correlation_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (worker_id, tenant_id, project_id)
    REFERENCES workers(worker_id, tenant_id, project_id)
);

CREATE INDEX IF NOT EXISTS worker_audit_tenant_project_created
  ON worker_audit_events(tenant_id, project_id, created_at);

CREATE TRIGGER IF NOT EXISTS worker_audit_no_update
BEFORE UPDATE ON worker_audit_events
BEGIN
  SELECT RAISE(ABORT, 'worker audit events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS worker_audit_no_delete
BEFORE DELETE ON worker_audit_events
BEGIN
  SELECT RAISE(ABORT, 'worker audit events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS worker_heartbeats_no_update
BEFORE UPDATE ON worker_heartbeats
BEGIN
  SELECT RAISE(ABORT, 'worker heartbeats are append-only');
END;

CREATE TRIGGER IF NOT EXISTS worker_heartbeats_no_delete
BEFORE DELETE ON worker_heartbeats
BEGIN
  SELECT RAISE(ABORT, 'worker heartbeats are append-only');
END;
