CREATE TABLE d1_test_assertions (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO d1_test_assertions
SELECT CASE WHEN
  (SELECT COUNT(*) FROM worker_heartbeats WHERE worker_id = 'worker-d1-revoked') = 0
  AND
  (SELECT heartbeat_sequence FROM workers WHERE worker_id = 'worker-d1-revoked') = 0
  AND
  (SELECT state FROM workers WHERE worker_id = 'worker-d1-revoked') = 'ACTIVE'
  AND
  (SELECT lease_expires_at FROM workers WHERE worker_id = 'worker-d1-revoked') IS NULL
  AND
  (SELECT record_version FROM workers WHERE worker_id = 'worker-d1-revoked') = 1
THEN 1 ELSE 0 END;
DROP TABLE d1_test_assertions;
