INSERT INTO project_quotas (
  tenant_id, project_id, active_jobs, max_active_jobs,
  max_cpu_millis_per_job, max_memory_mib_per_job, max_timeout_seconds, updated_at
) VALUES ('tenant-d1-test', 'project-d1-test', 0, 10, 8000, 8192, 3600, '2026-11-28T10:00:00Z');

INSERT INTO workers (
  worker_id, tenant_id, project_id, pool_id, provisioner_subject,
  provider, region, worker_class, trust_class, state, registration_epoch,
  heartbeat_sequence, capacity_max_concurrency, capacity_cpu_millis,
  capacity_memory_bytes, capacity_disk_bytes, revoked_at, record_version,
  created_at, updated_at
) VALUES (
  'worker-d1-revoked', 'tenant-d1-test', 'project-d1-test', 'pool-d1',
  'provisioner:d1-test', 'linux_host', 'eu-west', 'cpu', 'persistent',
  'ACTIVE', 1, 0, 4, 4000, 8589934592, 53687091200,
  '2026-11-28T09:00:00Z', 1, '2026-11-28T08:00:00Z', '2026-11-28T09:00:00Z'
);

INSERT INTO worker_enrollment_challenges (
  challenge_id, worker_id, challenge_hash, provisioner_subject,
  expires_at, consumed_at, created_at
) VALUES (
  'challenge-d1-expired', 'worker-d1-revoked', 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  'provisioner:d1-test', '2026-11-28T09:00:00Z', NULL, '2026-11-28T08:00:00Z'
);

INSERT INTO worker_provisioning_requests (
  provisioning_request_id, provisioner_subject, idempotency_key_hash,
  request_digest, state, correlation_id, created_at, updated_at, completed_at, expires_at
) VALUES (
  'request-d1-test', 'provisioner:d1-test',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'PENDING', 'corr-d1-test', '2026-11-28T08:00:00Z',
  '2026-11-28T08:00:00Z', NULL, '2026-11-29T08:00:00Z'
);
