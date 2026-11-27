import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "0001_compute_core.sql"


class ComputeCoreMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))
        self.db.execute(
            "INSERT INTO project_quotas VALUES (?, ?, 0, 1, 4000, 4096, 3600, ?)",
            ("tenant-1", "project-1", "2026-11-28T00:00:00Z"),
        )
        self.db.execute(
            "INSERT INTO project_operation_policies VALUES (?, ?, ?, 1, 2000, 2048, 600, ?, ?)",
            ("tenant-1", "project-1", "image.thumbnail", "now", "now"),
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def accept(self, key_hash, request_hash, job_id):
        now = "2026-11-28T00:00:00Z"
        with self.db:
            cursor = self.db.cursor()
            cursor.execute(
                "INSERT OR IGNORE INTO idempotency_records "
                "(tenant_id, project_id, operation_id, idempotency_key_hash, request_hash, job_id, created_at) "
                "VALUES (?, ?, ?, ?, ?, NULL, ?)",
                ("tenant-1", "project-1", "image.thumbnail", key_hash, request_hash, now),
            )
            cursor.execute(
                "UPDATE project_quotas SET active_jobs = active_jobs + 1, updated_at = ? "
                "WHERE tenant_id = ? AND project_id = ? AND active_jobs < max_active_jobs "
                "AND ? <= max_cpu_millis_per_job AND ? <= max_memory_mib_per_job "
                "AND ? <= max_timeout_seconds AND changes() = 1 "
                "AND EXISTS (SELECT 1 FROM project_operation_policies p "
                "WHERE p.tenant_id = ? AND p.project_id = ? AND p.operation_id = ? "
                "AND p.enabled = 1 AND ? <= p.max_cpu_millis_per_job "
                "AND ? <= p.max_memory_mib_per_job AND ? <= p.max_timeout_seconds)",
                (now, "tenant-1", "project-1", 1000, 512, 120,
                 "tenant-1", "project-1", "image.thumbnail", 1000, 512, 120),
            )
            cursor.execute(
                "INSERT INTO jobs (job_id, tenant_id, project_id, actor_id, operation_id, input_json, "
                "constraints_json, output_policy_json, state, record_version, request_digest, correlation_id, "
                "created_at, updated_at, deadline_at) "
                "SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', 1, ?, ?, ?, ?, NULL WHERE changes() = 1",
                (job_id, "tenant-1", "project-1", "actor-1", "image.thumbnail", "{}", "{}",
                 '{"format":"json","max_bytes":1024}', request_hash, "corr-1", now, now),
            )
            cursor.execute(
                "UPDATE idempotency_records SET job_id = ? WHERE tenant_id = ? AND project_id = ? "
                "AND operation_id = ? AND idempotency_key_hash = ? AND job_id IS NULL AND changes() = 1",
                (job_id, "tenant-1", "project-1", "image.thumbnail", key_hash),
            )
            cursor.execute(
                "INSERT INTO audit_events (event_id, tenant_id, project_id, actor_id, action, resource_id, "
                "request_digest, correlation_id, created_at) "
                "SELECT ?, ?, ?, ?, 'JOB_CREATED', ?, ?, ?, ? WHERE changes() = 1",
                (job_id, "tenant-1", "project-1", "actor-1", job_id, request_hash, "corr-1", now),
            )
            cursor.execute(
                "INSERT INTO outbox_events (event_id, tenant_id, project_id, aggregate_type, aggregate_id, "
                "aggregate_version, event_type, payload_json, created_at, published_at) "
                "SELECT ?, ?, ?, 'JOB', ?, 1, 'JOB_ACCEPTED', ?, ?, NULL WHERE changes() = 1",
                (job_id + "-outbox", "tenant-1", "project-1", job_id,
                 '{"job_state":"QUEUED"}', now),
            )
            cursor.execute(
                "DELETE FROM idempotency_records WHERE tenant_id = ? AND project_id = ? "
                "AND operation_id = ? AND idempotency_key_hash = ? AND job_id IS NULL",
                ("tenant-1", "project-1", "image.thumbnail", key_hash),
            )
        return self.db.execute(
            "SELECT request_hash, job_id FROM idempotency_records WHERE tenant_id = ? "
            "AND project_id = ? AND operation_id = ? AND idempotency_key_hash = ?",
            ("tenant-1", "project-1", "image.thumbnail", key_hash),
        ).fetchone()

    def test_first_acceptance_atomically_persists_job_audit_outbox_and_quota(self):
        record = self.accept("key-hash-1", "request-hash-1", "job-1")
        self.assertEqual(record, ("request-hash-1", "job-1"))
        self.assertEqual(self.db.execute("SELECT active_jobs FROM project_quotas").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM outbox_events").fetchone()[0], 1)

    def test_same_idempotency_key_and_payload_replays_without_reserving_quota_twice(self):
        self.accept("key-hash-1", "request-hash-1", "job-1")
        replay = self.accept("key-hash-1", "request-hash-1", "job-2")
        self.assertEqual(replay, ("request-hash-1", "job-1"))
        self.assertEqual(self.db.execute("SELECT active_jobs FROM project_quotas").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1)

    def test_same_idempotency_key_with_different_payload_keeps_original_claim(self):
        self.accept("key-hash-1", "request-hash-1", "job-1")
        conflict = self.accept("key-hash-1", "different-hash", "job-2")
        self.assertEqual(conflict, ("request-hash-1", "job-1"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1)

    def test_quota_race_does_not_leave_orphan_idempotency_claim(self):
        self.accept("key-hash-1", "request-hash-1", "job-1")
        denied = self.accept("key-hash-2", "request-hash-2", "job-2")
        self.assertIsNone(denied)
        self.assertEqual(self.db.execute("SELECT active_jobs FROM project_quotas").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1)

    def test_terminal_transition_releases_active_job_quota(self):
        self.accept("key-hash-1", "request-hash-1", "job-1")
        self.db.execute(
            "UPDATE jobs SET state = 'SUCCEEDED', record_version = record_version + 1, updated_at = ? WHERE job_id = ?",
            ("2026-11-28T00:01:00Z", "job-1"),
        )
        self.assertEqual(self.db.execute("SELECT active_jobs FROM project_quotas").fetchone()[0], 0)

    def test_queued_job_cancellation_is_terminal_and_releases_quota(self):
        self.accept("key-hash-1", "request-hash-1", "job-1")
        now = "2026-11-28T00:01:00Z"
        with self.db:
            self.db.execute(
                "UPDATE jobs SET state = CASE WHEN state = 'QUEUED' AND NOT EXISTS "
                "(SELECT 1 FROM executions e WHERE e.job_id = jobs.job_id) THEN 'CANCELLED' "
                "ELSE 'CANCEL_REQUESTED' END, record_version = record_version + 1, updated_at = ? "
                "WHERE job_id = ? AND state IN ('QUEUED', 'SCHEDULED', 'DISPATCHED', 'RUNNING')",
                (now, "job-1"),
            )
            self.db.execute(
                "INSERT INTO audit_events (event_id, tenant_id, project_id, actor_id, action, resource_id, correlation_id, created_at) "
                "SELECT ?, tenant_id, project_id, ?, CASE WHEN state = 'CANCELLED' THEN 'JOB_CANCELLED' "
                "ELSE 'JOB_CANCEL_REQUESTED' END, job_id, ?, ? FROM jobs WHERE job_id = ? AND changes() = 1",
                ("cancel-audit", "actor-1", "corr-1", now, "job-1"),
            )
            self.db.execute(
                "INSERT INTO outbox_events (event_id, tenant_id, project_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_json, created_at, published_at) "
                "SELECT ?, tenant_id, project_id, 'JOB', job_id, record_version, "
                "CASE WHEN state = 'CANCELLED' THEN 'JOB_CANCELLED' ELSE 'JOB_CANCEL_REQUESTED' END, "
                "json_object('job_id', job_id, 'state', state), ?, NULL FROM jobs WHERE job_id = ? AND changes() = 1",
                ("cancel-outbox", now, "job-1"),
            )
        self.assertEqual(self.db.execute("SELECT state FROM jobs WHERE job_id = 'job-1'").fetchone()[0], "CANCELLED")
        self.assertEqual(self.db.execute("SELECT active_jobs FROM project_quotas").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT action FROM audit_events WHERE event_id = 'cancel-audit'").fetchone()[0], "JOB_CANCELLED")
        self.assertEqual(self.db.execute("SELECT event_type FROM outbox_events WHERE event_id = 'cancel-outbox'").fetchone()[0], "JOB_CANCELLED")

    def test_running_job_cancellation_remains_a_request_until_worker_acknowledges(self):
        self.accept("key-hash-1", "request-hash-1", "job-1")
        self.db.execute("UPDATE jobs SET state = 'RUNNING' WHERE job_id = 'job-1'")
        now = "2026-11-28T00:01:00Z"
        with self.db:
            self.db.execute(
                "UPDATE jobs SET state = CASE WHEN state = 'QUEUED' AND NOT EXISTS "
                "(SELECT 1 FROM executions e WHERE e.job_id = jobs.job_id) THEN 'CANCELLED' "
                "ELSE 'CANCEL_REQUESTED' END, record_version = record_version + 1, updated_at = ? "
                "WHERE job_id = ? AND state IN ('QUEUED', 'SCHEDULED', 'DISPATCHED', 'RUNNING')",
                (now, "job-1"),
            )
            self.db.execute(
                "INSERT INTO audit_events (event_id, tenant_id, project_id, actor_id, action, resource_id, correlation_id, created_at) "
                "SELECT ?, tenant_id, project_id, ?, CASE WHEN state = 'CANCELLED' THEN 'JOB_CANCELLED' "
                "ELSE 'JOB_CANCEL_REQUESTED' END, job_id, ?, ? FROM jobs WHERE job_id = ? AND changes() = 1",
                ("cancel-audit", "actor-1", "corr-1", now, "job-1"),
            )
            self.db.execute(
                "INSERT INTO outbox_events (event_id, tenant_id, project_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_json, created_at, published_at) "
                "SELECT ?, tenant_id, project_id, 'JOB', job_id, record_version, "
                "CASE WHEN state = 'CANCELLED' THEN 'JOB_CANCELLED' ELSE 'JOB_CANCEL_REQUESTED' END, "
                "json_object('job_id', job_id, 'state', state), ?, NULL FROM jobs WHERE job_id = ? AND changes() = 1",
                ("cancel-outbox", now, "job-1"),
            )
        self.assertEqual(self.db.execute("SELECT state FROM jobs WHERE job_id = 'job-1'").fetchone()[0], "CANCEL_REQUESTED")
        self.assertEqual(self.db.execute("SELECT active_jobs FROM project_quotas").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT event_type FROM outbox_events WHERE event_id = 'cancel-outbox'").fetchone()[0], "JOB_CANCEL_REQUESTED")

    def test_audit_events_are_append_only(self):
        self.accept("key-hash-1", "request-hash-1", "job-1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE audit_events SET action = 'TAMPERED' WHERE event_id = 'job-1'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM audit_events WHERE event_id = 'job-1'")


if __name__ == "__main__":
    unittest.main()
