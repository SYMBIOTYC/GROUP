#!/usr/bin/env bash
set -euo pipefail

DATABASE="symbiotyc-group-compute-state"
CONFIG="wrangler.jsonc"
PERSIST=".wrangler/d1-migration-acceptance"

# Every D1 command is explicitly local and uses an isolated disposable state path.
npx --yes wrangler@4 d1 migrations apply "$DATABASE" \
  --local --persist-to "$PERSIST" --config "$CONFIG"

npx --yes wrangler@4 d1 migrations list "$DATABASE" \
  --local --persist-to "$PERSIST" --config "$CONFIG"

SQL="
SELECT CASE WHEN COUNT(*) = 7
  THEN 'MIGRATION_LEDGER_OK'
  ELSE 'MIGRATION_LEDGER_FAIL'
END AS result
FROM d1_migrations;

SELECT CASE WHEN COUNT(*) = 12
  THEN 'SECURITY_TRIGGERS_OK'
  ELSE 'SECURITY_TRIGGERS_FAIL'
END AS result
FROM sqlite_master
WHERE type = 'trigger'
  AND name IN (
    'worker_heartbeat_fencing',
    'worker_heartbeat_advance_snapshot',
    'worker_supersede_expired_challenge',
    'worker_enrollment_challenge_immutable_claims',
    'worker_provisioning_request_claims_immutable',
    'worker_provisioning_request_transition_guard',
    'worker_provisioning_request_completed_no_update',
    'worker_provisioning_request_no_delete',
    'worker_provisioning_requests_initial_pending',
    'amphetamin_activation_events_identity_immutable',
    'amphetamin_activation_events_apply_once',
    'amphetamin_activation_events_no_delete'
  );

SELECT CASE WHEN COUNT(*) = 2
  THEN 'AMPHETAMIN_TABLES_OK'
  ELSE 'AMPHETAMIN_TABLES_FAIL'
END AS result
FROM sqlite_master
WHERE type = 'table'
  AND name IN ('amphetamin_activation_state', 'amphetamin_activation_events');

SELECT CASE WHEN COUNT(*) = 0
  THEN 'FOREIGN_KEYS_OK'
  ELSE 'FOREIGN_KEYS_FAIL'
END AS result
FROM pragma_foreign_key_check;
"

OUTPUT="$(npx --yes wrangler@4 d1 execute "$DATABASE" \
  --local --persist-to "$PERSIST" --config "$CONFIG" \
  --command "$SQL" --json)"
printf '%s\n' "$OUTPUT"

for marker in MIGRATION_LEDGER_OK SECURITY_TRIGGERS_OK AMPHETAMIN_TABLES_OK FOREIGN_KEYS_OK; do
  if ! grep -q "$marker" <<<"$OUTPUT"; then
    echo "D1 migration acceptance failed: missing $marker" >&2
    exit 1
  fi
done

if grep -qE 'MIGRATION_LEDGER_FAIL|SECURITY_TRIGGERS_FAIL|AMPHETAMIN_TABLES_FAIL|FOREIGN_KEYS_FAIL' <<<"$OUTPUT"; then
  echo "D1 migration acceptance returned a failed invariant" >&2
  exit 1
fi

echo "Disposable local D1 migration acceptance passed for migrations 0001–0007."
