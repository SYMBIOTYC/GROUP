import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"
AMPHETAMIN_MIGRATION = "0007_amphetamin_activation_state.sql"


class FullMigrationSequenceTests(unittest.TestCase):
    def test_complete_migration_set_including_amphetamin_applies_in_ordinal_order(self):
        migration_files = sorted(MIGRATIONS.glob("[0-9][0-9][0-9][0-9]_*.sql"))
        names = [path.name for path in migration_files]

        self.assertIn(
            AMPHETAMIN_MIGRATION,
            names,
            "AMPHETAMIN must use the next mainline migration ordinal (0007), "
            "after Worker Registry migrations 0004-0006",
        )
        self.assertEqual(names, sorted(names), "migrations must be applied lexicographically")

        db = sqlite3.connect(":memory:")
        try:
            db.execute("PRAGMA foreign_keys = ON")
            for migration in migration_files:
                with self.subTest(migration=migration.name):
                    db.executescript(migration.read_text(encoding="utf-8"))

            tables = {
                row[0]
                for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            self.assertIn("project_quotas", tables)
            self.assertIn("workers", tables)
            self.assertIn("worker_provisioning_requests", tables)
            self.assertIn("amphetamin_activation_state", tables)
            self.assertIn("amphetamin_activation_events", tables)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
