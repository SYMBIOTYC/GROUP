# Worker Identity and Enrollment Contract v1

**Date:** 2026-11-28  
**Status:** design decision / implementation gate  
**Owner:** SYMBIOTYC/GROUP  
**Protocol:** `symbiotyc.compute.v1`

## 1. Decision

Worker Registry control is a GROUP responsibility. AMPHETAMIN remains a Job API client and MUST NOT register, configure, drain, revoke, or authenticate as a Worker.

Worker identity has two separate trust paths:

1. **Enrollment authority → GROUP:** a narrowly scoped infrastructure provisioner enrolls a host. The provisioner identity must be independently authenticated and authorized by GROUP. It is not the AMPHETAMIN user principal.
2. **Worker agent → GROUP:** the enrolled agent authenticates every heartbeat using a short-lived, audience-bound Worker credential bound to a server-issued `worker_id` and `registration_epoch`.

No caller-supplied `tenant_id`, `worker_id`, pool, trust tier, or capability is authoritative. GROUP derives tenant and pool ownership from the authenticated enrollment authority and server-side policy.

## 2. Enrollment lifecycle

1. An authorized provisioner requests enrollment for an approved pool/provider/region and a declared host identity.
2. GROUP validates the provisioner scope and pool policy. Public GitHub PR workflows are ineligible for persistent pools.
3. GROUP issues a server-generated `worker_id`, random `registration_epoch`, and one-time enrollment challenge with a short TTL. Only a cryptographic hash of the challenge is persisted.
4. The agent exchanges the challenge once over the authenticated enrollment channel. GROUP atomically consumes it and issues a short-lived Worker access credential.
5. The credential is returned once, stored only in the host's protected secret store, and never written to Git, CI logs, job payloads, or audit metadata.
6. Heartbeats authenticate the Worker credential and must match the current `worker_id`, epoch, and monotonically increasing sequence.
7. Credential rotation invalidates the previous credential. Drain prevents new placement; revoke invalidates all credentials and epochs.

The initial enrollment authority is a prerequisite, not assumed to exist. Until it is provisioned and independently verified, registration remains disabled.

## 3. Worker credential

The v1 access token is a signed, short-lived JWT with strict validation:

- fixed algorithm allowlist; reject `none` and algorithm substitution;
- issuer: the deployed GROUP identity issuer;
- audience: `symbiotyc.compute.worker-heartbeat.v1`;
- subject: server-issued `worker_id`;
- claims: `registration_epoch`, `jti`, `iat`, `nbf`, `exp`;
- short expiry (target 5 minutes);
- signature key held only as a Cloudflare Worker secret, never in D1 or repository files;
- current credential/JTI and epoch checked against durable state on every mutation.

The signing key must support key rotation with an explicit key ID. D1 stores only credential identifiers/hashes and lifecycle metadata, never bearer tokens or private signing material.

## 4. Registry state model

- `PENDING_ENROLLMENT`: server record created; challenge not yet exchanged.
- `ACTIVE`: enrollment completed, credential current, lease fresh, and policy permits placement.
- `DEGRADED`: authenticated heartbeat reports degraded health or capacity.
- `DRAINING`: no new placement; existing work may finish.
- `OFFLINE`: lease expired; not eligible for placement.
- `REVOKED`: terminal administrative state; all credentials and epochs invalid.

A stale heartbeat cannot restore an OFFLINE worker. Recovery requires a fresh authenticated heartbeat under the current epoch and an explicit policy transition. A revoked worker cannot self-reactivate; it requires a new enrollment and a new server-issued identity.

## 5. Heartbeat invariants

- Require valid signature, issuer, audience, expiry, subject, JTI, and current registration epoch.
- Require a strictly increasing integer sequence; duplicate or out-of-order sequences return conflict and do not extend the lease.
- Ignore caller-supplied tenant/project identity; resolve ownership from the Worker row.
- Bound observed clock skew and payload size. Server receive time, not agent time, determines lease expiry.
- Validate reported capacity against registered ceilings. Agent-reported capacity is an observation, not a grant to raise quota.
- Commit heartbeat sequence, health/capacity snapshot, lease expiry, audit event, and outbox event atomically.
- Drain and revoke use version preconditions and append-only audit events.

## 6. Persistence model (planned migration)

The migration will add:
- `workers`: server identity, pool, provider/region, trust class, state, declared ceilings, current epoch, heartbeat sequence, lease expiry, timestamps, record version;
- `worker_enrollment_challenges`: challenge hash, worker ID, issuer, expiry, consumed timestamp; unique one-time consumption;
- `worker_credentials`: credential JTI/hash, worker ID, epoch, key ID, issued/expiry/revocation timestamps;
- `worker_heartbeats`: immutable accepted sequence and bounded capacity/health snapshots;
- audit/outbox events for every state transition.

Constraints and indexes must enforce unique identity, one current epoch, one-time challenge consumption, and efficient lease expiry scans. Tenant and pool ownership are assigned from provisioner policy, never from agent input.

## 7. Required negative tests before implementation is accepted

1. Missing or invalid provisioner identity cannot enroll a Worker.
2. AMPHETAMIN user/service principal cannot call Worker administration endpoints.
3. Enrollment challenge is one-time, expires, and cannot be replayed concurrently.
4. Worker cannot select its own ID, tenant, pool, trust class, or capabilities.
5. Wrong issuer, audience, signature, expiry, JTI, or epoch is rejected.
6. Revoked/rotated credentials stop working immediately.
7. Duplicate and out-of-order heartbeat sequence does not refresh lease.
8. Expired lease makes Worker ineligible; stale heartbeat cannot silently reactivate it.
9. Capacity above registered ceilings is rejected or clamped by explicit policy; it never increases quota.
10. Tenant isolation holds for list/get/drain/revoke and all database mutations.
11. Heartbeat + audit + outbox are atomic; failed transaction leaves no partial state.
12. Public PR runners cannot enroll into persistent CLOUD-CPU or CLOUD-VPS pools.

## 8. Release gates

- **I0:** provisioner identity and enrollment channel are deployed and verified.
- **I1:** migration and schema tests pass.
- **I2:** enrollment challenge and credential rotation tests pass.
- **I3:** heartbeat lease/sequence and revocation tests pass.
- **I4:** tenant-isolation and negative authorization tests pass.
- **I5:** staging host registers, heartbeats, drains, and revokes with runtime evidence.
- **I6:** registry is deployed; scheduler still remains disabled until reservation/dispatcher gates pass.

No Worker Registry endpoint or production dispatch may be enabled before I0–I5. The current AMPHETAMIN Service Binding is not an enrollment authority.


## Provisioner runtime boundary v1

The separate Provisioner deployment, Access ingress, private GROUP Service Binding, enrollment request/proof schemas, one-time challenge exchange, and ES256 Worker JWT profile are specified normatively in [Provisioner Runtime and Enrollment Boundary v1](provisioner-runtime-contract.md).

Machine-readable contracts:
- `contracts/provisioner-enrollment-request-v1.schema.json`
- `contracts/worker-enrollment-proof-v1.schema.json`

These schemas reject caller-selected tenant/project/worker identity, trust class, capabilities, and extra fields. They do not imply that enrollment routes or credentials are deployed.


## Provisioner idempotency persistence

Migration `0006_worker_provisioning_requests.sql` adds a durable ledger keyed by Provisioner subject plus a SHA-256 hash of the idempotency key. The request digest binds the key to one canonical request; a changed payload under the same key must return 409. Raw idempotency keys are not persisted. The ledger is committed atomically with Worker, challenge, audit, and outbox state; SQLite checks do not substitute for D1 transaction/failure-injection evidence.


## I0.26.5 migration review findings

The production rollout review identified three schema-level requirements that must be resolved before migrations 0004–0006 are applied:

- Migration 0005 must check `workers.revoked_at IS NULL` in both heartbeat admission and snapshot-update predicates, independently of the ACTIVE/DEGRADED state enum. This aligns database fencing with the I0.26.3 credential resolver guard.
- Migration 0004's one-unconsumed-challenge partial unique index currently includes expired challenges. The enrollment lifecycle must explicitly supersede/expire an old challenge so an expired unconsumed row cannot block a replacement.
- Migration 0006 must protect Provisioner subject, idempotency-key hash, and request digest from mutation and enforce the intended PENDING → COMPLETED transition invariants.

These are review findings, not applied fixes. Production D1 remains at migrations 0001–0003. Do not apply 0004–0006 or enable enrollment/heartbeat until corrected migrations, negative tests, CI, and a separately authorized rollout are complete. See [I0.26.5 migration rollout review](worker-heartbeat-transaction-boundary.md#i0265--production-d1-migration-rollout-review-2026-11-28).


## I0.26.6 — migration defect corrections (2026-11-28)

Implementation is present on the I0.26.6 draft branch. GitHub Actions run for the code/test commit completed successfully: Python schema-conformance suite and Node runtime unit suite both report success. This confirms repository CI only; no disposable D1-compatible or production D1 execution is claimed. See [draft PR #19](https://github.com/SYMBIOTYC/GROUP/pull/19). No production D1 migration was applied.

- **B1 — heartbeat revocation fencing:** both the BEFORE INSERT eligibility predicate and AFTER INSERT snapshot-update predicate in migration 0005 now require `workers.revoked_at IS NULL`. A revoked Worker cannot accept a heartbeat or advance its lease snapshot, including if its state is inconsistently ACTIVE/DEGRADED.
- **B2 — enrollment challenge lifecycle:** migration 0004 adds `superseded_at`. The one-unconsumed-challenge unique index and expiry index now cover only rows with both `consumed_at IS NULL` and `superseded_at IS NULL`. A BEFORE INSERT trigger supersedes an existing challenge only when its `expires_at <= NEW.created_at`; the replacement operation must provide server-generated UTC `created_at`. A still-unexpired challenge continues to block a replacement. `consumed_at` retains its original meaning.
- **B3 — Provisioner idempotency ledger:** migration 0006 requires new requests to enter as PENDING with no completion outcome. The only permitted update is one PENDING-to-COMPLETED transition; subject, idempotency-key hash, request digest, request ID, correlation ID, creation time and expiry are immutable. Completion requires a timestamp, non-empty outcome code and JSON outcome. Subsequent updates are rejected.

Regression coverage for the three findings and fixture adjustments is in `tests/test_worker_registry_migration.py`. The test suite has **not yet been executed**: the available GitHub Actions query returned no workflow runs and the execution environment could not resolve github.com for a checkout. SQLite/D1 parity is therefore not claimed. Next gate: execute the complete migration tests in CI and a disposable D1-compatible database, review all results, then request separate authorization before any production rollout.


## I0.26.7 — isolated D1-compatible migration verification (2026-11-28)

The I0.26.6 migration corrections are now verified in Wrangler's **local D1 runtime** using a disposable local database configuration with synthetic database IDs and explicit `--local` commands. No remote D1 resource was created or accessed by this workflow.

- **Migration sequence:** Wrangler applied migrations `0001` through `0006` sequentially to the isolated local D1 database.
- **B1:** a revoked Worker whose state is inconsistently ACTIVE was rejected by the heartbeat trigger; the heartbeat row, sequence, lease, state and record version remained unchanged.
- **B2:** an expired unconsumed challenge was superseded on replacement; the consumed marker remained untouched; an unexpired challenge continued to block a second replacement. A superseded challenge cannot be reopened or rebound, and a consumed challenge cannot be reopened or superseded.
- **B3:** idempotency subject, key hash and request digest are immutable; a PENDING request completed once; the Worker binding could be assigned at completion but cannot subsequently be cleared or rebound; completed requests cannot be reopened.
- **Schema integrity:** the local D1 test asserts exactly six migration ledger entries and no rows from `pragma_foreign_key_check`.
- **Migration failure recovery:** a separate disposable local D1 database applies a baseline migration, then attempts a deliberately failing migration. CI asserts that the failed migration's partial table is rolled back while the prior migration and its data remain intact.

**CI evidence**
- [Wrangler local D1 migration compatibility — success](https://github.com/SYMBIOTYC/GROUP/actions/runs/46156482128)
- [Python schema and migration tests — success](https://github.com/SYMBIOTYC/GROUP/actions/runs/46156482135)
- [Node runtime unit tests — success](https://github.com/SYMBIOTYC/GROUP/actions/runs/46156482167)

The local D1 run validates the Wrangler/Miniflare local D1 execution path, not the live Cloudflare production database. No production D1 migrations were applied. No production routes, bindings, secrets, Scheduler or dispatch were changed. I0.20 credential provisioning remains an independent blocker; Worker enrollment/heartbeat endpoints and scheduling remain disabled. Production rollout still requires a separate review and explicit authorization.

Implementation and executable checks are in [draft PR #19](https://github.com/SYMBIOTYC/GROUP/pull/19). Keep the PR draft; do not merge at this stage.


## I0.26.8 — read-only production D1 rollout preflight (2026-11-28)

**Decision: HOLD — production application is not approved.** This stage was read-only and made no Cloudflare resource or database changes.

- Re-resolved the deployed `symbiotyc-group-control-plane` Worker settings. The live D1 binding is still `DB` and points to the production compute-state database; no preview database is configured.
- Queried production `sqlite_master`, the `d1_migrations` ledger and `PRAGMA foreign_key_check`. The ledger still contains only `0001_compute_core.sql`, `0002_runtime_ledger.sql` and `0003_compute_approvals.sql`.
- No `workers`, `worker_credentials`, `worker_enrollment_challenges`, `worker_heartbeats`, `worker_audit_events`, or Worker Registry triggers/indexes are present in the live schema. The existing `project_quotas` parent key is the expected composite primary key `(tenant_id, project_id)`.
- `PRAGMA foreign_key_check` returned no violations.
- D1 query metadata reported `changed_db=false` and `rows_written=0`; only schema and migration-ledger metadata were read.

The local Wrangler/Miniflare verification from I0.26.7 is green, but it does not replace production D1 verification. Migrations `0004–0006` remain unapplied in production. The I0.20 secure credential-provisioning gate is still blocked; Worker enrollment/heartbeat routes and Scheduler/dispatch remain disabled. A separate explicit production-rollout authorization and final preflight are required before any migration is applied.

Evidence and implementation: [I0.26.7 local D1 CI](https://github.com/SYMBIOTYC/GROUP/actions/runs/46156482128), [draft PR #19](https://github.com/SYMBIOTYC/GROUP/pull/19). PR remains draft; no merge.


## I0.26.9 — production trust-provisioning readiness recheck (2026-11-28)

**Decision: BLOCKED — do not provision or roll out.** This stage used read-only Cloudflare API calls only.

Observed account state:
- GROUP Access application `2db93e50-e75b-4674-b55e-47631a2b7acf` exists for `symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev`.
- GROUP Access application policy count: **0**. No allow policy is present.
- Account Access Service Token count: **0**.
- The account's `default_secrets_store` exists, but its secret count is **0**.
- Cloudflare GET for Worker `symbiotyc-group-provisioner` settings returned HTTP 404 / error 10007: the Worker does not exist in the account. The repository scaffold is therefore not a deployed runtime.
- No Service Token, Access policy, secret, Worker deployment, binding, route, or D1 resource was created or changed.

**I0.20 blocker remains active:** the available session has no approved one-time secret capture and secure storage handoff. The presence of a Secrets Store API does not make it safe to submit a newly generated client secret through this session: write-only values cannot be read back, and no approved secure handoff to the operator was established. Do not create a Service Token or Secrets Store secret until an authorized capture path is available. Do not put credentials in chat, Git, D1, Worker logs, or ordinary tool output.

### Required exit criteria
1. Operator-approved secret capture path is available and tested without exposing the value in chat or logs.
2. Create one narrowly scoped, time-bounded Service Token; securely capture the one-time client secret and retain only non-secret token metadata in the change record.
3. Create the exact default-deny-compatible Access policy selecting only that token ID; read back policy and app state.
4. Provision the Provisioner Worker only after its authenticated private Service Binding contract, runtime config, and fail-closed behavior are reviewed; no public enrollment endpoint.
5. Bind only the minimum required secrets/configuration; verify bindings by metadata without reading or printing secret values.
6. Verify authenticated private Provisioner→GROUP invocation and negative cases before enabling any enrollment path.
7. Separately authorize and execute the production D1 migration rollout; this stage is not that authorization.

Until all criteria pass, Worker enrollment/heartbeat routes remain absent or disabled, Worker scheduling remains ineligible, and Scheduler/dispatch remain disabled. Migrations `0004–0006` remain unapplied in production. PR #19 remains draft and unmerged.
