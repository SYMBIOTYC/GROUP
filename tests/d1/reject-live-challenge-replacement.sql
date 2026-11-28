INSERT INTO worker_enrollment_challenges (
  challenge_id, worker_id, challenge_hash, provisioner_subject,
  expires_at, consumed_at, created_at
) VALUES (
  'challenge-d1-live-blocked', 'worker-d1-revoked',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'provisioner:d1-test', '2026-11-28T13:00:00Z', NULL, '2026-11-28T10:30:00Z'
);
