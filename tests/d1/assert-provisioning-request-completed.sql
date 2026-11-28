CREATE TABLE d1_test_assertions (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO d1_test_assertions
SELECT CASE WHEN
  (SELECT state FROM worker_provisioning_requests WHERE provisioning_request_id = 'request-d1-test') = 'COMPLETED'
  AND
  (SELECT request_digest FROM worker_provisioning_requests WHERE provisioning_request_id = 'request-d1-test') = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  AND
  (SELECT worker_id FROM worker_provisioning_requests WHERE provisioning_request_id = 'request-d1-test') = 'worker-d1-revoked'
  AND
  (SELECT outcome_code FROM worker_provisioning_requests WHERE provisioning_request_id = 'request-d1-test') = 'ENROLLED'
THEN 1 ELSE 0 END;
DROP TABLE d1_test_assertions;
