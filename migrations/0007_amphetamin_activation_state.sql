-- Durable AMPHETAMIN activation state and idempotent deployment/tick events.
-- One state row per tenant/project; events are retained for replay protection and audit.

CREATE TABLE IF NOT EXISTS amphetamin_activation_state (
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  activation_remaining_minutes INTEGER NOT NULL DEFAULT 0 CHECK (activation_remaining_minutes BETWEEN 0 AND 600),
  deployment_streak INTEGER NOT NULL DEFAULT 0 CHECK (deployment_streak BETWEEN 0 AND 5),
  burnout_score INTEGER NOT NULL DEFAULT 0 CHECK (burnout_score BETWEEN 0 AND 100),
  recovery_remainder_minutes INTEGER NOT NULL DEFAULT 0 CHECK (recovery_remainder_minutes BETWEEN 0 AND 59),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id)
);

CREATE TABLE IF NOT EXISTS amphetamin_activation_events (
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 8 AND 128),
  event_type TEXT NOT NULL CHECK (event_type IN ('deployment', 'tick')),
  occurred_at TEXT NOT NULL,
  applied_at TEXT,
  PRIMARY KEY (tenant_id, project_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_amphetamin_activation_events_pending
  ON amphetamin_activation_events (tenant_id, project_id, applied_at, occurred_at);

CREATE TRIGGER IF NOT EXISTS amphetamin_activation_events_identity_immutable
BEFORE UPDATE ON amphetamin_activation_events
WHEN NEW.tenant_id != OLD.tenant_id
  OR NEW.project_id != OLD.project_id
  OR NEW.event_id != OLD.event_id
  OR NEW.event_type != OLD.event_type
  OR NEW.occurred_at != OLD.occurred_at
BEGIN
  SELECT RAISE(ABORT, 'AMPHETAMIN activation event identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS amphetamin_activation_events_apply_once
BEFORE UPDATE ON amphetamin_activation_events
WHEN OLD.applied_at IS NOT NULL
  OR NEW.applied_at IS NULL
  OR changes() != 1
BEGIN
  SELECT RAISE(ABORT, 'AMPHETAMIN activation event can be applied only once');
END;

CREATE TRIGGER IF NOT EXISTS amphetamin_activation_events_no_delete
BEFORE DELETE ON amphetamin_activation_events
BEGIN
  SELECT RAISE(ABORT, 'AMPHETAMIN activation events are retained for idempotency and audit');
END;
