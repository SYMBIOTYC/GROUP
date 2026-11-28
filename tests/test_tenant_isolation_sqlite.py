import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORE_MIGRATION = ROOT / "migrations" / "0001_compute_core.sql"
ACTIVATION_MIGRATION = ROOT / "migrations" / "0004_amphetamin_activation_state.sql"


class TenantIsolationSqliteIntegrationTests(unittest.TestCase):
    """Exercise the production SQL predicates against real SQLite and repo migrations."""

    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(CORE_MIGRATION.read_text(encoding="utf-8"))
        self.db.executescript(ACTIVATION_MIGRATION.read_text(encoding="utf-8"))
        self._seed_tenant("tenant-a", "project-a")
        self._seed_tenant("tenant-b", "project-b")
        self._seed_job("job-tenant-a", "tenant-a", "project-a")
        self._seed_job("job-tenant-b", "tenant-b", "project-b")
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _seed_tenant(self, tenant_id, project_id):
        now = "2026-11-28T12:00:00Z"
        self.db.execute(
            "INSERT INTO project_quotas VALUES (?, ?, 0, 5, 4000, 4096, 3600, ?)",
            (tenant_id, project_id, now),
        )
        self.db.execute(
            "INSERT INTO project_operation_policies VALUES (?, ?, ?, 1, 2000, 2048, 600, ?, ?)",
            (tenant_id, project_id, "image.thumbnail", now, now),
        )

    def _seed_job(self, job_id, tenant_id, project_id):
        now = "2026-11-28T12:00:00Z"
        self.db.execute(
            "INSERT INTO jobs (job_id, tenant_id, project_id, actor_id, operation_id, input_json, "
            "constraints_json, output_policy_json, state, record_version, request_digest, correlation_id, "
            "created_at, updated_at, deadline_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', 1, ?, ?, ?, ?, NULL)",
            (job_id, tenant_id, project_id, "actor-" + tenant_id, "image.thumbnail",
             "{}", "{}", '{"format":"json","max_bytes":1024}', "digest-" + job_id,
             "correlation-" + tenant_id, now, now),
        )

    def test_known_job_id_is_not_readable_across_tenant_project_boundary(self):
        row = self.db.execute(
            "SELECT job_id, state, correlation_id FROM jobs "
            "WHERE job_id = ? AND tenant_id = ? AND project_id = ?",
            ("job-tenant-b", "tenant-a", "project-a"),
        ).fetchone()

        self.assertIsNone(row)
        tenant_b_row = self.db.execute(
            "SELECT job_id, state, correlation_id FROM jobs "
            "WHERE job_id = ? AND tenant_id = ? AND project_id = ?",
            ("job-tenant-b", "tenant-b", "project-b"),
        ).fetchone()
        self.assertEqual(tenant_b_row, ("job-tenant-b", "QUEUED", "correlation-tenant-b"))

    def test_cross_tenant_cancel_is_noop_and_emits_no_audit_or_outbox(self):
        now = "2026-11-28T12:01:00Z"
        with self.db:
            self.db.execute(
                "UPDATE jobs SET state = CASE WHEN state = 'QUEUED' AND NOT EXISTS "
                "(SELECT 1 FROM executions e WHERE e.job_id = jobs.job_id) THEN 'CANCELLED' "
                "ELSE 'CANCEL_REQUESTED' END, record_version = record_version + 1, updated_at = ? "
                "WHERE job_id = ? AND tenant_id = ? AND project_id = ? "
                "AND state IN ('QUEUED', 'SCHEDULED', 'DISPATCHED', 'RUNNING')",
                (now, "job-tenant-b", "tenant-a", "project-a"),
            )
            self.db.execute(
                "INSERT INTO audit_events (event_id, tenant_id, project_id, actor_id, action, "
                "resource_id, correlation_id, created_at) "
                "SELECT ?, tenant_id, project_id, ?, CASE WHEN state = 'CANCELLED' "
                "THEN 'JOB_CANCELLED' ELSE 'JOB_CANCEL_REQUESTED' END, job_id, ?, ? "
                "FROM jobs WHERE job_id = ? AND changes() = 1",
                ("cross-tenant-cancel-audit", "actor-tenant-a", "corr-tenant-a", now, "job-tenant-b"),
            )
            self.db.execute(
                "INSERT INTO outbox_events (event_id, tenant_id, project_id, aggregate_type, "
                "aggregate_id, aggregate_version, event_type, payload_json, created_at, published_at) "
                "SELECT ?, tenant_id, project_id, 'JOB', job_id, record_version, "
                "CASE WHEN state = 'CANCELLED' THEN 'JOB_CANCELLED' ELSE 'JOB_CANCEL_REQUESTED' END, "
                "json_object('job_id', job_id, 'state', state), ?, NULL "
                "FROM jobs WHERE job_id = ? AND changes() = 1",
                ("cross-tenant-cancel-outbox", now, "job-tenant-b"),
            )

        row = self.db.execute(
            "SELECT state, record_version FROM jobs WHERE job_id = ? AND tenant_id = ? AND project_id = ?",
            ("job-tenant-b", "tenant-b", "project-b"),
        ).fetchone()
        self.assertEqual(row, ("QUEUED", 1))
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0], 0
        )
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM outbox_events").fetchone()[0], 0
        )

    def test_idempotency_key_claim_is_not_replayed_across_tenants(self):
        self.db.execute(
            "INSERT INTO idempotency_records "
            "(tenant_id, project_id, operation_id, idempotency_key_hash, request_hash, job_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("tenant-b", "project-b", "image.thumbnail", "shared-key-hash",
             "tenant-b-request-hash", "job-tenant-b", "2026-11-28T12:00:00Z"),
        )
        self.db.commit()

        tenant_a_replay = self.db.execute(
            "SELECT request_hash, job_id FROM idempotency_records "
            "WHERE tenant_id = ? AND project_id = ? AND operation_id = ? AND idempotency_key_hash = ?",
            ("tenant-a", "project-a", "image.thumbnail", "shared-key-hash"),
        ).fetchone()
        tenant_b_claim = self.db.execute(
            "SELECT request_hash, job_id FROM idempotency_records "
            "WHERE tenant_id = ? AND project_id = ? AND operation_id = ? AND idempotency_key_hash = ?",
            ("tenant-b", "project-b", "image.thumbnail", "shared-key-hash"),
        ).fetchone()

        self.assertIsNone(tenant_a_replay)
        self.assertEqual(tenant_b_claim, ("tenant-b-request-hash", "job-tenant-b"))

    def test_activation_state_is_loaded_only_for_the_authenticated_tenant_project(self):
        now = "2026-11-28T12:00:00.000Z"
        self.db.execute(
            "INSERT INTO amphetamin_activation_state "
            "(tenant_id, project_id, activation_remaining_minutes, deployment_streak, "
            "burnout_score, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("tenant-a", "project-a", 120, 1, 10, now, 3),
        )
        self.db.execute(
            "INSERT INTO amphetamin_activation_state "
            "(tenant_id, project_id, activation_remaining_minutes, deployment_streak, "
            "burnout_score, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("tenant-b", "project-b", 540, 5, 90, now, 17),
        )
        self.db.commit()

        row = self.db.execute(
            "SELECT activation_remaining_minutes, deployment_streak, burnout_score, version "
            "FROM amphetamin_activation_state WHERE tenant_id = ? AND project_id = ?",
            ("tenant-a", "project-a"),
        ).fetchone()

        self.assertEqual(row, (120, 1, 10, 3))
        self.assertNotEqual(row[3], 17)


if __name__ == "__main__":
    unittest.main()
