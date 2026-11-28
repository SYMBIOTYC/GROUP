CREATE TABLE d1_test_assertions (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO d1_test_assertions
SELECT CASE WHEN
  (SELECT COUNT(*) FROM d1_migrations) = 6
  AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
THEN 1 ELSE 0 END;
DROP TABLE d1_test_assertions;
