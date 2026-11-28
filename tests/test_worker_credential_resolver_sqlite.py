import re
import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def resolver_sql():
    source = (ROOT / "src" / "worker-credential-resolver.mjs").read_text(encoding="utf-8")
    match = re.search(r"const LOOKUP_SQL = `([\\s\\S]*?)`;", source)
    if not match:
        raise AssertionError("LOOKUP_SQL template not found in resolver source")
    return match.group(1)


class WorkerCredentialResolverSQLiteIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        for migration in ("0001_compute_core.sql", "0004_worker_registry.sql", "0005_worker_heartbeat_fencing.sql"):
            self.db.executescript((ROOT / "migrations" / migration).read_text(encoding="utf-8"))
        self.db.execute(
            "INSERT INTO project_quotas VALUES (?, ?, 0, 10, 8000, 8192, 3600, ?)",
            ("tenant-a", "project-a", "2026-11-28T00:00:00Z"),
        )
        self.db.execute(
            """INSERT INTO workers (
                worker_id, tenant_id, project_id, pool_id, provisioner_subject,
                provider, region, worker_class, trust_class, state, registration_epoch,
                capacity_max_concurrency, capacity_cpu_millis, capacity_memory_bytes,
                capacity_disk_bytes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("worker-a", "tenant-a", "project-a", "pool-a", "provisioner:test", "linux_host",
             "eu-west", "cpu", "persistent", "ACTIVE", 7, 2, 4000, 8589934592, 0, "now", "now"),
        )
        self.db.execute(
            """INSERT INTO worker_credentials (
                credential_id, worker_id, registration_epoch, token_jti, token_hash,
                signing_key_id, issued_at, expires_at, revoked_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("credential-a", "worker-a", 7, "jti-a", "a" * 64, "kid-a",
             "2026-11-28T11:00:00Z", "2026-11-28T12:05:00Z", None),
        )
        self.sql = resolver_sql()
        self.params = ("worker-a", "jti-a", 7, "kid-a", "2026-11-28T12:00:00.000Z")

    def tearDown(self):
        self.db.close()

    def lookup(self):
        return self.db.execute(self.sql, self.params).fetchone()

    def test_resolver_query_executes_against_migration_schema(self):
        row = self.lookup()
        self.assertIsNotNone(row)
        self.assertEqual(row[0:8], (
            "worker-a", "tenant-a", "project-a", "ACTIVE", 7,
            "jti-a", "kid-a", "2026-11-28T12:05:00Z"
        ))
        self.assertIsNone(row[8])

    def test_revoked_credential_is_not_resolved(self):
        self.db.execute("UPDATE worker_credentials SET revoked_at = ? WHERE credential_id = ?",
                        ("2026-11-28T11:59:00Z", "credential-a"))
        self.assertIsNone(self.lookup())

    def test_revoked_worker_is_not_resolved_even_if_state_is_inconsistent(self):
        self.db.execute("UPDATE workers SET revoked_at = ? WHERE worker_id = 'worker-a'",
                        ("2026-11-28T11:59:00Z",))
        self.assertIsNone(self.lookup())

    def test_expired_credential_is_not_resolved(self):
        self.db.execute("UPDATE worker_credentials SET expires_at = ? WHERE credential_id = ?",
                        ("2026-11-28T11:59:59Z", "credential-a"))
        self.assertIsNone(self.lookup())

    def test_stale_registration_epoch_is_not_resolved(self):
        self.db.execute("UPDATE workers SET registration_epoch = 8 WHERE worker_id = 'worker-a'")
        self.assertIsNone(self.lookup())

    def test_inactive_worker_is_not_resolved(self):
        self.db.execute("UPDATE workers SET state = 'DRAINING' WHERE worker_id = 'worker-a'")
        self.assertIsNone(self.lookup())

    def test_key_and_jti_mismatch_are_not_resolved(self):
        self.db.execute("UPDATE worker_credentials SET signing_key_id = 'other-kid' WHERE credential_id = 'credential-a'")
        self.assertIsNone(self.lookup())
        self.db.execute("UPDATE worker_credentials SET signing_key_id = 'kid-a', token_jti = 'other-jti' WHERE credential_id = 'credential-a'")
        self.assertIsNone(self.lookup())

    def test_tenant_and_project_are_taken_from_server_side_worker_row(self):
        row = self.lookup()
        self.assertEqual((row[1], row[2]), ("tenant-a", "project-a"))
        self.assertNotIn("tenant_id = ?", self.sql)


if __name__ == "__main__":
    unittest.main()
