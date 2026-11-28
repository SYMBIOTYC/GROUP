INSERT INTO worker_enrollment_challenges (
  challenge_id, worker_id, challenge_hash, provisioner_subject,
  expires_at, consumed_at, created_at
) VALUES (
  'challenge-d1-replacement', 'worker-d1-revoked',
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  'provisioner:d1-test', '2026-11-28T12:00:00Z', NULL, '2026-11-28T10:00:00Z'
);

CREATE TABLE d1_test_assertions (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO d1_test_assertions
SELECT CASE WHEN
  (SELECT superseded_at FROM worker_enrollment_challenges WHERE challenge_id = 'challenge-d1-expired') = '2026-11-28T10:00:00Z'
  AND
  (SELECT consumed_at FROM worker_enrollment_challenges WHERE challenge_id = 'challenge-d1-expired') IS NULL
  AND
  (SELECT COUNT(*) FROM worker_enrollment_challenges
   WHERE worker_id = 'worker-d1-revoked' AND consumed_at IS NULL AND superseded_at IS NULL) = 1
THEN 1 ELSE 0 END;
DROP TABLE d1_test_assertions;
