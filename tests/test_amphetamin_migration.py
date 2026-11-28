import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "0007_amphetamin_activation_state.sql"


class AmphetaminActivationMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def test_state_is_tenant_project_scoped_and_starts_at_zero(self):
        self.db.execute(
            "INSERT INTO amphetamin_activation_state (tenant_id, project_id, updated_at) VALUES (?, ?, ?)",
            ("tenant-a", "project-a", "2026-11-28T10:00:00.000Z"),
        )
        self.db.execute(
            "INSERT INTO amphetamin_activation_state (tenant_id, project_id, updated_at) VALUES (?, ?, ?)",
            ("tenant-b", "project-a", "2026-11-28T10:00:00.000Z"),
        )
        rows = self.db.execute(
            "SELECT tenant_id, activation_remaining_minutes, deployment_streak, burnout_score, version "
            "FROM amphetamin_activation_state ORDER BY tenant_id"
        ).fetchall()
        self.assertEqual(rows, [("tenant-a", 0, 0, 0, 0), ("tenant-b", 0, 0, 0, 0)])

    def test_event_identity_is_unique_per_tenant_project_and_replay_is_ignored(self):
        values = ("tenant-a", "project-a", "deploy-0001", "deployment", "2026-11-28T10:00:00.000Z", None)
        sql = ("INSERT OR IGNORE INTO amphetamin_activation_events "
               "(tenant_id, project_id, event_id, event_type, occurred_at, applied_at) VALUES (?, ?, ?, ?, ?, ?)")
        self.db.execute(sql, values)
        self.db.execute(sql, values)
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM amphetamin_activation_events").fetchone()[0], 1
        )
        self.db.execute(sql, ("tenant-a", "project-a", "deploy-0001", "tick",
                              "2026-11-28T10:01:00.000Z", None))
        self.assertEqual(
            self.db.execute(
                "SELECT event_type, occurred_at FROM amphetamin_activation_events WHERE event_id = ?",
                ("deploy-0001",),
            ).fetchone(),
            ("deployment", "2026-11-28T10:00:00.000Z"),
        )

    def test_event_identity_is_immutable_and_applied_event_cannot_be_reapplied(self):
        self.db.execute(
            "INSERT INTO amphetamin_activation_events VALUES (?, ?, ?, ?, ?, NULL)",
            ("tenant-a", "project-a", "deploy-0001", "deployment", "2026-11-28T10:00:00.000Z"),
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE amphetamin_activation_events SET event_type = 'tick' WHERE event_id = 'deploy-0001'"
            )
        self.db.execute(
            "UPDATE amphetamin_activation_events SET applied_at = ? WHERE event_id = ?",
            ("2026-11-28T10:00:01.000Z", "deploy-0001"),
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE amphetamin_activation_events SET applied_at = ? WHERE event_id = ?",
                ("2026-11-28T10:00:02.000Z", "deploy-0001"),
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM amphetamin_activation_events WHERE event_id = 'deploy-0001'")


    def test_state_version_and_event_application_are_atomic_and_idempotent(self):
        now = "2026-11-28T10:00:00.000Z"
        self.db.execute(
            "INSERT INTO amphetamin_activation_state (tenant_id, project_id, updated_at) VALUES (?, ?, ?)",
            ("tenant-a", "project-a", now),
        )
        self.db.execute(
            "INSERT INTO amphetamin_activation_events "
            "(tenant_id, project_id, event_id, event_type, occurred_at) VALUES (?, ?, ?, ?, ?)",
            ("tenant-a", "project-a", "deploy-0001", "deployment", now),
        )
        update_state = (
            "UPDATE amphetamin_activation_state SET activation_remaining_minutes = ?, "
            "deployment_streak = ?, burnout_score = ?, updated_at = ?, version = version + 1 "
            "WHERE tenant_id = ? AND project_id = ? AND version = ? AND EXISTS "
            "(SELECT 1 FROM amphetamin_activation_events WHERE tenant_id = ? AND project_id = ? "
            "AND event_id = ? AND applied_at IS NULL)"
        )
        mark_event = (
            "UPDATE amphetamin_activation_events SET applied_at = ? WHERE tenant_id = ? "
            "AND project_id = ? AND event_id = ? AND applied_at IS NULL AND changes() = 1"
        )
        with self.db:
            self.db.execute(
                update_state,
                (180, 1, 15, now, "tenant-a", "project-a", 0,
                 "tenant-a", "project-a", "deploy-0001"),
            )
            self.db.execute(mark_event, (now, "tenant-a", "project-a", "deploy-0001"))
        state = self.db.execute(
            "SELECT activation_remaining_minutes, deployment_streak, burnout_score, version "
            "FROM amphetamin_activation_state WHERE tenant_id = ? AND project_id = ?",
            ("tenant-a", "project-a"),
        ).fetchone()
        self.assertEqual(state, (180, 1, 15, 1))

        with self.db:
            self.db.execute(
                update_state,
                (360, 2, 30, now, "tenant-a", "project-a", 1,
                 "tenant-a", "project-a", "deploy-0001"),
            )
            self.db.execute(mark_event, (now, "tenant-a", "project-a", "deploy-0001"))
        replayed = self.db.execute(
            "SELECT activation_remaining_minutes, deployment_streak, burnout_score, version "
            "FROM amphetamin_activation_state WHERE tenant_id = ? AND project_id = ?",
            ("tenant-a", "project-a"),
        ).fetchone()
        self.assertEqual(replayed, state)

    def test_optimistic_version_conflict_rolls_back_state_and_event(self):
        now = "2026-11-28T10:00:00.000Z"
        self.db.execute(
            "INSERT INTO amphetamin_activation_state (tenant_id, project_id, version, updated_at) "
            "VALUES (?, ?, 2, ?)",
            ("tenant-a", "project-a", now),
        )
        self.db.execute(
            "INSERT INTO amphetamin_activation_events "
            "(tenant_id, project_id, event_id, event_type, occurred_at) VALUES (?, ?, ?, ?, ?)",
            ("tenant-a", "project-a", "deploy-0002", "deployment", now),
        )
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                self.db.execute(
                    "UPDATE amphetamin_activation_state SET version = version + 1 "
                    "WHERE tenant_id = ? AND project_id = ?",
                    ("tenant-a", "project-a"),
                )
                self.db.execute(
                    "UPDATE amphetamin_activation_state SET activation_remaining_minutes = 180 "
                    "WHERE tenant_id = ? AND project_id = ? AND version = 2 AND EXISTS "
                    "(SELECT 1 FROM amphetamin_activation_events WHERE event_id = ? AND applied_at IS NULL)",
                    ("tenant-a", "project-a", "deploy-0002"),
                )
                self.db.execute(
                    "UPDATE amphetamin_activation_events SET applied_at = ? WHERE event_id = ? "
                    "AND applied_at IS NULL",
                    (now, "deploy-0002"),
                )
        row = self.db.execute(
            "SELECT applied_at FROM amphetamin_activation_events WHERE event_id = ?",
            ("deploy-0002",),
        ).fetchone()
        state = self.db.execute(
            "SELECT activation_remaining_minutes, version FROM amphetamin_activation_state "
            "WHERE tenant_id = ? AND project_id = ?",
            ("tenant-a", "project-a"),
        ).fetchone()
        self.assertEqual(row, (None,))
        self.assertEqual(state, (0, 2))

    def test_state_constraints_prevent_activation_and_burnout_overflow(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO amphetamin_activation_state "
                "(tenant_id, project_id, activation_remaining_minutes, updated_at) VALUES (?, ?, ?, ?)",
                ("tenant-a", "project-a", 601, "2026-11-28T10:00:00.000Z"),
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO amphetamin_activation_state "
                "(tenant_id, project_id, burnout_score, updated_at) VALUES (?, ?, ?, ?)",
                ("tenant-b", "project-a", 101, "2026-11-28T10:00:00.000Z"),
            )


if __name__ == "__main__":
    unittest.main()
