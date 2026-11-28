CREATE TABLE migration_rollback_probe (
  id TEXT PRIMARY KEY
);
INSERT INTO table_that_does_not_exist (id) VALUES ('force-rollback');
