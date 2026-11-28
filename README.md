# SYMBIOTYC COMPUTE GROUP

**Role:** Compute Control Plane for the SYMBIOTYC Cloud federation.  
**Protocol:** `symbiotyc.compute.v1`  
**Status:** GROUP Worker is deployed in the primary Cloudflare production account with its dedicated EU D1 binding. AMPHETAMIN has a private Service Binding to GROUP. The GROUP workers.dev hostname is enabled with Preview URLs disabled; its dedicated Access application is attached and remains default-deny with no policies. No compute dispatch is enabled.

GROUP owns compute-resource coordination across `CLOUD-COMPUTE`, `CLOUD-CPU`, and `CLOUD-VPS`. It is the authority for Worker registration and eligibility, scheduling, capacity reservations, dispatch coordination, quotas, policy, lifecycle state, and audit.

AMPHETAMIN is a separate product with its own MCP interface. It is an ingress client of GROUP; it does not administer Workers or connect to Worker endpoints directly.

## Architecture

```
AMPHETAMIN MCP
    |
    | authenticated JobIntent (symbiotyc.compute.v1)
    v
GROUP — Compute Control Plane
    |-- Worker Registry
    |-- Scheduler + atomic capacity reservation
    |-- Dispatcher + attempt/lease fencing
    |-- Quota and policy enforcement
    |-- Durable Job/Execution state + audit/outbox
    |
    +---- CLOUD-COMPUTE
    +---- CLOUD-CPU
    +---- CLOUD-VPS
```

## Repository contents

- `contracts/` — machine-readable protocol schemas.
- `docs/architecture.md` — authority boundaries and component model.
- `tests/` — schema conformance tests.
- `wrangler.toml` — private Worker configuration with `workers_dev=false`, `preview_urls=false`, no routes, and the dedicated EU D1 binding.

## Canonical documentation

The normative architecture, execution lifecycle, API semantics, security model, operations, and acceptance criteria are maintained in the [SYMBIOTYC Cloud Wiki](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/tree/main/Architecture/Compute-Infrastructure).

- [Compute Infrastructure index](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/README.md)
- [AMPHETAMIN MCP contract](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/AMPHETAMIN-MCP.md)
- [Compute Control Plane](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Compute-Control-Plane.md)
- [Worker Registry](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Worker-Registry.md)
- [Execution Lifecycle](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Execution-Lifecycle.md)
- [Live deployment verification (2026-11-28)](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Live-Deployment-Verification-2026-11-28.md)

## Security invariants

- Tenant, project, actor, and Worker trust are derived from authenticated server-side identity, never from caller-controlled request fields.
- AMPHETAMIN submits JobIntent and reads authorized results only; it has no direct Worker control.
- Worker classes and capabilities are allowlisted by GROUP policy. A Worker cannot grant itself trust or raise its own quota.
- Jobs are bounded by operation allowlists, resource ceilings, deadlines, tenant quotas, and sandbox profiles.
- Idempotency is atomically claimed and payload-digest bound. Ambiguous outcomes are reconciled; retries never create a new intent.
- Worker messages are fenced by authenticated identity, execution ID, and current lease epoch/token.
- TaskResult is untrusted until schema, attempt, lease, output, and artifact integrity validation succeeds.
- Audit and state transitions are durable and append-only; secrets and raw credentials never enter repository files or audit payloads.

## Worker identity and enrollment

- [Worker Identity and Enrollment Contract v1](docs/worker-identity-and-enrollment-contract.md) — provisioner/agent trust separation, one-time enrollment, short-lived Worker credentials, heartbeat fencing and release gates.
- `migrations/0004_worker_registry.sql` — durable Worker, capability, one-time challenge, credential, heartbeat and append-only audit tables. Storage foundation only; no enrollment or heartbeat routes are enabled.
- `migrations/0005_worker_heartbeat_fencing.sql` — database-enforced heartbeat epoch/sequence/state/capacity fencing and atomic Worker lease snapshot advancement.
- `tests/test_worker_registry_migration.py` — SQLite migration invariants for tenant/project binding, challenge uniqueness, heartbeat sequence uniqueness and append-only audit.

- [F2.3 Transactional Heartbeat blocker](docs/worker-heartbeat-transaction-boundary.md) — independent Provisioner/Worker credential authority prerequisite and atomic heartbeat contract.
- [Provisioner Runtime and Enrollment Boundary v1](docs/provisioner-runtime-contract.md) — isolated Provisioner deployment, trust boundaries, enrollment API, one-time challenge, ES256 Worker JWT, and acceptance tests.
- `contracts/provisioner-enrollment-request-v1.schema.json` and `contracts/worker-enrollment-proof-v1.schema.json` — strict machine-readable enrollment payloads.
- `tests/test_provisioner_contract.py` — schema-level negative tests for caller-selected identity/trust and capacity limits.

## Deployment configuration

- [GROUP deployment record](docs/deployment-record.md)
- [Cloudflare Worker configuration](wrangler.jsonc)

## Implementation status

The repository includes the initial protocol schemas, Job API source core, D1 migration, private Service Binding contract, and passing Node/Python CI. The dedicated EU D1 database `symbiotyc-group-compute-state` has been provisioned and the initial migration applied and verified. The GROUP Worker `symbiotyc-group-control-plane` is deployed with the dedicated D1 binding; its `workers.dev` subdomain is enabled with Preview URLs disabled and a dedicated Cloudflare Access self-hosted application attached; the Access app currently has no policies (default-deny). The AMPHETAMIN Worker has a live `GROUP` Service Binding to this service. The Access-protected MCP edge exposes only the read-only `group.health` probe. An authenticated external MCP round-trip has not yet been verified. Scheduler, dispatcher, Worker agent, provider adapter, result/artifact pipeline, and production dispatch remain disabled until the end-to-end acceptance gates pass.

The dated [live deployment verification](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Live-Deployment-Verification-2026-11-28.md) records the account-side evidence and remaining gaps. A Worker script existing in the account is not proof that the complete compute lifecycle is operational.


## One-time compute approval service

PR #10 adds the private approval API and the D1 migration `0003_compute_approvals.sql`.

- `POST /v1/approvals` requires `compute:approvals:write`, a private AMPHETAMIN caller assertion, and an Idempotency-Key. It binds an approval to tenant, project, actor, action, operation, request SHA-256, and a 30–300 second TTL.
- `POST /v1/approvals/{approval_id}/consume` requires `compute:approvals:consume` and atomically consumes the matching approval exactly once.
- Submit approvals require an enabled project operation policy and configured quota.
- Cancel approvals require an existing non-terminal Job in the same tenant/project.
- Approval claims are immutable; approvals cannot be deleted; audit events are append-only.

**Production state (2026-11-28):** The D1 migration has been applied and recorded in `d1_migrations` alongside the existing 0001 and 0002 baseline. The table, index, and three triggers are present. The GROUP Worker source contains the new routes on `main`, but the live Worker has not yet been upgraded; the Cloudflare upload was blocked by the security layer. These endpoints are therefore not yet active in production. GROUP's repository target config sets `workers_dev=false` and `preview_urls=false`; live Cloudflare state is separate: the `workers.dev` subdomain is enabled with Preview URLs disabled and the dedicated Access app remains default-deny (`policies=[]`).

- `migrations/0006_worker_provisioning_requests.sql` — durable Provisioner-subject-scoped idempotency ledger; schema only, not applied to production D1.
- `provisioner/` — isolated, quarantined Provisioner Worker scaffold; deployment manifest declares a private GROUP Service Binding, but Access verification, GROUP authorization, and deployment are not implemented.
- `tests/test_provisioner_runtime_layout.py` — static checks for Provisioner isolation and fail-closed defaults; execution not yet verified.
- `src/worker-jwt.mjs` and `tests/worker-jwt.test.mjs` — isolated strict ES256 Worker JWT verifier and focused negative tests; run with `node --test tests/worker-jwt.test.mjs`. The verifier is not wired to an HTTP route.
- `src/worker-credential-resolver.mjs` and `tests/worker-credential-resolver.test.mjs` — fail-closed D1-backed Worker/JTI/epoch/kid lookup; run with `node --test tests/worker-credential-resolver.test.mjs`. It is not wired into the verifier or deployed GROUP runtime.
- `tests/test_worker_credential_resolver_sqlite.py` — executes the resolver's exact SQL against SQLite after applying migrations 0001, 0004 and 0005; run with `python -m unittest tests.test_worker_credential_resolver_sqlite -v`.
- `src/provisioner-auth.mjs` and `tests/provisioner-auth.test.mjs` — isolated ES256 Provisioner assertion verifier and focused negative tests; verifier is not wired to an enrollment route and trust keys are not configured.
- `provisioner/src/provisioner-assertion.mjs` and `tests/provisioner-assertion.test.mjs` — request-bound ES256 Provisioner assertion signer and GROUP-verifier interoperability tests; no runtime key or binding configured.
- `src/provisioner-request-binding.mjs` and `tests/provisioner-request-binding.test.mjs` — GROUP-side canonical request binding computed from the received HTTP request; the verifier recomputes `rqh`/`ikh` and ignores caller-supplied digest headers. Runtime CI: 85/85 passed on `001473f90f11d79b71accb411a456a39d7c5785e`. Still not wired to an enrollment route.


## I0.26.4 — production D1 schema inventory

The deployed GROUP Worker `DB` binding was resolved read-only to production database `symbiotyc-group-compute-state`. Its migration ledger contains only 0001–0003. Worker Registry tables and heartbeat-fencing triggers are absent; migrations 0004–0006 are not applied. The I0.26.2/3 credential resolver therefore cannot run against the currently bound production D1. No D1 changes were made. See [runtime contract](docs/provisioner-runtime-contract.md#i0264--read-only-production-d1-schema-inventory-2026-11-28) and [F2.3 transaction gate](docs/worker-heartbeat-transaction-boundary.md#i0264--read-only-production-d1-schema-inventory-2026-11-28).


## I0.26.5 — production D1 migration rollout review

**HOLD — migrations 0004–0006 are not approved for production application.** Source review found three blockers: 0005 heartbeat triggers omit the independent Worker `revoked_at` guard; 0004's one-unconsumed-challenge index lets expired challenges block replacement; and 0006 lacks immutable idempotency-claim/state-transition guards. See [runtime contract](docs/provisioner-runtime-contract.md#i0265--production-d1-migration-rollout-review-2026-11-28), [F2.3 transaction gate](docs/worker-heartbeat-transaction-boundary.md#i0265--production-d1-migration-rollout-review-2026-11-28), and [identity contract](docs/worker-identity-and-enrollment-contract.md#i0265-migration-review-findings). No production D1 changes were made.

## I0.26.6 — quarantined enrollment request preparation

Added a preparation-only GROUP module that composes ES256 Provisioner assertion verification with strict enrollment-contract validation. It consumes the same parsed body produced by request-binding verification and preserves the original request stream. It performs no D1 access and is not wired to a route. Runtime CI passed 94/94 tests (run #243, ID `46155487464`); schema/conformance CI passed (run #249, ID `46155487501`) on implementation/documentation commit `59340ff5d89e0770d389f09160b99fb4d9f25de6`. The first run caught a required-key iteration defect, corrected before the passing run. The I0.26.5 production D1 migration HOLD and B1–B3 blockers remain unchanged.


Worker Registry migration corrections (I0.26.7): see [heartbeat transaction boundary](docs/worker-heartbeat-transaction-boundary.md#i0267--worker-registry-migration-security-corrections-2026-11-28) and [Provisioner runtime contract](docs/provisioner-runtime-contract.md#i0267--worker-registry-migration-security-corrections-2026-11-28). Production migration remains on HOLD.


### I0.26.7 verification addendum

GitHub Actions verification completed successfully on implementation commit `25c9b2702998419d8ac9d63be0d8d8fc615dd957`:
- GROUP runtime + Worker Registry migration/resolver tests: run #276 / ID `46155964495`, success. Node runtime suite: 94 passed; `test_worker_registry_migration.py`: 20 passed; `test_worker_credential_resolver_sqlite.py`: 8 passed.
- Compute protocol/schema conformance: run #282 / ID `46155964423`, success.

The first Python CI attempt exposed a test-fixture timestamp issue in the PENDING → COMPLETED transition test. The fixture was corrected to advance `updated_at`; the successful run above validates the corrected commit. These tests execute against disposable in-memory SQLite databases initialized from the checked-in migrations, not the production D1 database.

**Result:** source-level B1–B3 blockers are addressed and the migration regression suites pass. Production rollout remains HOLD: no migrations have been applied to production D1, no live route/binding/secret has changed, and separate backup/restore readiness plus explicit production migration authorization are still required.


I0.26.8 production D1 read-only preflight: target DB is confirmed, but production ledger contains only migrations 0001–0003 and no Worker Registry schema. Migrations 0004–0006 remain unapplied; rollout HOLD. See [heartbeat transaction boundary](docs/worker-heartbeat-transaction-boundary.md#i0268--production-d1-read-only-preflight-2026-11-28).

## I0.26.9 — disposable local D1 migration acceptance

CI now applies migrations 0001–0006 through Wrangler v4 against an isolated local D1 database and asserts six migration ledger rows, all nine critical Worker Registry security triggers, and zero FK violations. Run #298 passed (94/94 runtime tests, 22 migration tests, 8 resolver tests, local D1 acceptance); schema conformance run #305 passed. Production D1 remains unchanged and rollout HOLD pending independent backup/restore rehearsal and explicit authorization.

## I0.26.10 — production backup/restore readiness audit

Read-only checks confirm the production D1 Time Travel bookmark endpoint is available, but no independent export or restore rehearsal exists. The export API may make D1 unavailable to queries while the export runs. No export or restore was executed. Production rollout remains HOLD pending owner approval for full export, independent storage, and a separate disposable restore drill.


### I0.26.11 — production D1 backup/restore gate

The I0.26.11 read-only audit confirms Time Travel support but no independently retrievable backup. Cloudflare reports R2 is not enabled for the account context. A full D1 export can block database requests; export, independent storage provisioning, and a remote disposable-D1 restore rehearsal are held for explicit owner approval. Production migrations 0004–0006 remain unapplied. See [worker heartbeat transaction boundary](docs/worker-heartbeat-transaction-boundary.md#i02611--external-backup-destination-and-restore-rehearsal-gate-2026-11-28) and [Provisioner runtime contract](docs/provisioner-runtime-contract.md#i02611--external-backup-destination-and-restore-rehearsal-gate-2026-11-28).
