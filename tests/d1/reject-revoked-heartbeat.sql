INSERT INTO worker_heartbeats (
  worker_id, heartbeat_sequence, registration_epoch, health_state,
  observed_concurrency, observed_cpu_millis, observed_memory_bytes,
  received_at, lease_expires_at
) VALUES (
  'worker-d1-revoked', 1, 1, 'healthy', 0, 0, 0,
  '2026-11-28T10:01:00Z', '2026-11-28T10:06:00Z'
);
