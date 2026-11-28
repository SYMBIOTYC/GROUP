import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "0004_amphetamin_activation_state.sql"


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
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(sql, ("tenant-a", "project-a", "deploy-0001", "tick",
                                  "2026-11-28T10:01:00.000Z", None))

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
