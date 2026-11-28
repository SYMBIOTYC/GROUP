-- Enforce heartbeat fencing in the database, not only in HTTP handler code.
-- An accepted heartbeat and the Worker lease snapshot update are one SQLite statement.

CREATE TRIGGER IF NOT EXISTS worker_heartbeat_fencing
BEFORE INSERT ON worker_heartbeats
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM workers w
    WHERE w.worker_id = NEW.worker_id
      AND w.registration_epoch = NEW.registration_epoch
      AND w.heartbeat_sequence + 1 = NEW.heartbeat_sequence
      AND w.state IN ('ACTIVE', 'DEGRADED')
      AND NEW.observed_concurrency <= w.capacity_max_concurrency
      AND NEW.observed_cpu_millis <= w.capacity_cpu_millis
      AND NEW.observed_memory_bytes <= w.capacity_memory_bytes
  ) THEN RAISE(ABORT, 'heartbeat rejected: stale epoch, sequence, state, or capacity') END;
END;

CREATE TRIGGER IF NOT EXISTS worker_heartbeat_advance_snapshot
AFTER INSERT ON worker_heartbeats
BEGIN
  UPDATE workers
  SET heartbeat_sequence = NEW.heartbeat_sequence,
      state = CASE NEW.health_state
        WHEN 'healthy' THEN 'ACTIVE'
        ELSE 'DEGRADED'
      END,
      last_heartbeat_at = NEW.received_at,
      lease_expires_at = NEW.lease_expires_at,
      record_version = record_version + 1,
      updated_at = NEW.received_at
  WHERE worker_id = NEW.worker_id
    AND registration_epoch = NEW.registration_epoch
    AND heartbeat_sequence + 1 = NEW.heartbeat_sequence
    AND state IN ('ACTIVE', 'DEGRADED');
  SELECT CASE WHEN changes() != 1
    THEN RAISE(ABORT, 'heartbeat snapshot update lost fencing race') END;
END;
