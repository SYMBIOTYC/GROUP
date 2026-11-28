import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "migrations" / "0001_compute_core.sql"
REGISTRY = ROOT / "migrations" / "0004_worker_registry.sql"
FENCING = ROOT / "migrations" / "0005_worker_heartbeat_fencing.sql"


class WorkerRegistryMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(CORE.read_text(encoding="utf-8"))
        self.db.executescript(REGISTRY.read_text(encoding="utf-8"))
        self.db.executescript(FENCING.read_text(encoding="utf-8"))
        self.db.execute(
            "INSERT INTO project_quotas VALUES (?, ?, 0, 10, 8000, 8192, 3600, ?)",
            ("tenant-a", "project-a", "2026-11-28T00:00:00Z"),
        )
        self.db.execute(
            """INSERT INTO workers (
                worker_id, tenant_id, project_id, pool_id, provisioner_subject,
                provider, region, worker_class, trust_class, state,
                registration_epoch, capacity_max_concurrency, capacity_cpu_millis,
                capacity_memory_bytes, capacity_disk_bytes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 2, 4000, 8589934592, 53687091200, ?, ?)""",
            ("worker-a", "tenant-a", "project-a", "pool-a", "provisioner:test",
             "linux_host", "eu-west", "cpu", "persistent", "PENDING_ENROLLMENT",
             "now", "now"),
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_worker_is_bound_to_existing_tenant_project(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO workers (
                    worker_id, tenant_id, project_id, pool_id, provisioner_subject,
                    provider, region, worker_class, trust_class, state,
                    capacity_max_concurrency, capacity_cpu_millis,
                    capacity_memory_bytes, capacity_disk_bytes, created_at, updated_at
                ) VALUES ('worker-b', 'tenant-x', 'project-x', 'pool-a', 'p',
                    'linux_host', 'eu-west', 'cpu', 'persistent',
                    'PENDING_ENROLLMENT', 1, 1000, 16777216, 0, 'now', 'now')"""
            )

    def test_enrollment_challenge_hash_is_unique_and_only_one_pending_per_worker(self):
        self.db.execute(
            """INSERT INTO worker_enrollment_challenges
            VALUES ('challenge-1', 'worker-a', ?, 'provisioner:test', 'later', NULL, 'now')""",
            ("a" * 64,),
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO worker_enrollment_challenges
                VALUES ('challenge-2', 'worker-a', ?, 'provisioner:test', 'later', NULL, 'now')""",
                ("b" * 64,),
            )

    def test_challenge_hash_cannot_be_reused(self):
        self.db.execute(
            """INSERT INTO workers (
                worker_id, tenant_id, project_id, pool_id, provisioner_subject,
                provider, region, worker_class, trust_class, state,
                capacity_max_concurrency, capacity_cpu_millis,
                capacity_memory_bytes, capacity_disk_bytes, created_at, updated_at
            ) VALUES ('worker-b', 'tenant-a', 'project-a', 'pool-a', 'provisioner:test',
                'linux_host', 'eu-west', 'cpu', 'persistent', 'PENDING_ENROLLMENT',
                1, 1000, 16777216, 0, 'now', 'now')"""
        )
        self.db.execute(
            """INSERT INTO worker_enrollment_challenges
            VALUES ('challenge-a', 'worker-a', ?, 'provisioner:test', 'later', NULL, 'now')""",
            ("c" * 64,),
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO worker_enrollment_challenges
                VALUES ('challenge-b', 'worker-b', ?, 'provisioner:test', 'later', NULL, 'now')""",
                ("c" * 64,),
            )

    def test_heartbeat_sequence_is_unique_per_worker_and_append_only(self):
        self.db.execute("UPDATE workers SET state='ACTIVE' WHERE worker_id='worker-a'")
        self.db.execute(
            """INSERT INTO worker_heartbeats VALUES
            ('worker-a', 1, 1, 'healthy', 0, 0, 0, 'now', 'later')"""
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO worker_heartbeats VALUES
                ('worker-a', 1, 1, 'healthy', 0, 0, 0, 'now', 'later')"""
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE worker_heartbeats SET health_state='degraded' WHERE worker_id='worker-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM worker_heartbeats WHERE worker_id='worker-a'")


    def test_heartbeat_rejects_sequence_gap(self):
        self.db.execute("UPDATE workers SET state='ACTIVE' WHERE worker_id='worker-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO worker_heartbeats VALUES
                ('worker-a', 2, 1, 'healthy', 0, 0, 0, 'now', 'later')"""
            )

    def test_heartbeat_rejects_stale_registration_epoch(self):
        self.db.execute("UPDATE workers SET state='ACTIVE' WHERE worker_id='worker-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO worker_heartbeats VALUES
                ('worker-a', 1, 0, 'healthy', 0, 0, 0, 'now', 'later')"""
            )

    def test_heartbeat_rejects_worker_not_active(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO worker_heartbeats VALUES
                ('worker-a', 1, 1, 'healthy', 0, 0, 0, 'now', 'later')"""
            )

    def test_accepted_heartbeat_atomically_advances_worker_snapshot(self):
        self.db.execute("UPDATE workers SET state='ACTIVE' WHERE worker_id='worker-a'")
        self.db.execute(
            """INSERT INTO worker_heartbeats VALUES
            ('worker-a', 1, 1, 'degraded', 1, 500, 1024, 'received', 'lease-end')"""
        )
        snapshot = self.db.execute(
            """SELECT heartbeat_sequence, state, last_heartbeat_at,
                      lease_expires_at, record_version
               FROM workers WHERE worker_id='worker-a'"""
        ).fetchone()
        self.assertEqual(snapshot, (1, "DEGRADED", "received", "lease-end", 2))

    def test_worker_audit_is_append_only_and_tenant_scoped(self):
        self.db.execute(
            """INSERT INTO worker_audit_events VALUES
            ('event-1', 'worker-a', 'tenant-a', 'project-a', 'provisioner:test',
             'WORKER_ENROLLED', 1, 'corr-1', '{}', 'now')"""
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE worker_audit_events SET action='WORKER_REVOKED' WHERE event_id='event-1'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM worker_audit_events WHERE event_id='event-1'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO worker_audit_events VALUES
                ('event-2', 'worker-a', 'tenant-b', 'project-b', 'provisioner:test',
                 'WORKER_REVOKED', 2, 'corr-2', '{}', 'now')"""
            )



    def test_provisioning_request_ledger_binds_subject_key_and_digest(self):
        self.db.executescript((ROOT / "migrations" / "0006_worker_provisioning_requests.sql").read_text(encoding="utf-8"))
        self.db.execute(
            """INSERT INTO worker_provisioning_requests
               (provisioning_request_id, provisioner_subject, idempotency_key_hash,
                request_digest, state, correlation_id, created_at, updated_at, expires_at)
               VALUES ('request-1', 'provisioner:a', ?, ?, 'PENDING', 'corr-1', 'now', 'now', 'later')""",
            ("a" * 64, "b" * 64),
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO worker_provisioning_requests
                   (provisioning_request_id, provisioner_subject, idempotency_key_hash,
                    request_digest, state, correlation_id, created_at, updated_at, expires_at)
                   VALUES ('request-2', 'provisioner:a', ?, ?, 'PENDING', 'corr-2', 'now', 'now', 'later')""",
                ("a" * 64, "c" * 64),
            )

    def test_provisioning_request_key_is_scoped_to_provisioner_subject(self):
        self.db.executescript((ROOT / "migrations" / "0006_worker_provisioning_requests.sql").read_text(encoding="utf-8"))
        self.db.execute(
            """INSERT INTO worker_provisioning_requests
               (provisioning_request_id, provisioner_subject, idempotency_key_hash,
                request_digest, state, correlation_id, created_at, updated_at, expires_at)
               VALUES ('request-1', 'provisioner:a', ?, ?, 'PENDING', 'corr-1', 'now', 'now', 'later')""",
            ("a" * 64, "b" * 64),
        )
        self.db.execute(
            """INSERT INTO worker_provisioning_requests
               (provisioning_request_id, provisioner_subject, idempotency_key_hash,
                request_digest, state, correlation_id, created_at, updated_at, expires_at)
               VALUES ('request-2', 'provisioner:b', ?, ?, 'PENDING', 'corr-2', 'now', 'now', 'later')""",
            ("a" * 64, "b" * 64),
        )

    def test_provisioning_request_digest_and_hash_are_fixed_length(self):
        self.db.executescript((ROOT / "migrations" / "0006_worker_provisioning_requests.sql").read_text(encoding="utf-8"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO worker_provisioning_requests
                   (provisioning_request_id, provisioner_subject, idempotency_key_hash,
                    request_digest, state, correlation_id, created_at, updated_at, expires_at)
                   VALUES ('request-1', 'provisioner:a', 'short', ?, 'PENDING', 'corr-1', 'now', 'now', 'later')""",
                ("b" * 64,),
            )

    def test_provisioning_request_worker_reference_must_exist(self):
        self.db.executescript((ROOT / "migrations" / "0006_worker_provisioning_requests.sql").read_text(encoding="utf-8"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO worker_provisioning_requests
                   (provisioning_request_id, provisioner_subject, idempotency_key_hash,
                    request_digest, worker_id, state, correlation_id, created_at, updated_at, completed_at, expires_at)
                   VALUES ('request-1', 'provisioner:a', ?, ?, 'missing-worker', 'COMPLETED', 'corr-1', 'now', 'now', 'now', 'later')""",
                ("a" * 64, "b" * 64),
            )


if __name__ == "__main__":
    unittest.main()
