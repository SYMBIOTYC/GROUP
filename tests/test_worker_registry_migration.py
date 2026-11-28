import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "migrations" / "0001_compute_core.sql"
REGISTRY = ROOT / "migrations" / "0004_worker_registry.sql"


class WorkerRegistryMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(CORE.read_text(encoding="utf-8"))
        self.db.executescript(REGISTRY.read_text(encoding="utf-8"))
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



if __name__ == "__main__":
    unittest.main()
