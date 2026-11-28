# Provisioner Runtime and Enrollment Boundary v1

**Status:** normative design contract; isolated runtime scaffold committed, trust integration blocked by I0.20/I0.21  
**Owner:** SYMBIOTYC/GROUP · **Protocol:** `symbiotyc.compute.v1` · **Reviewed:** 2026-11-28

## 1. Scope

The Provisioner is a separately deployed infrastructure control-plane client. It is not AMPHETAMIN, not a Worker Agent, and not the GROUP JWT signing authority. This contract does not enable enrollment, heartbeat, scheduling, or dispatch.

## 2. Trust boundaries

| Boundary | Authentication | Authority |
|---|---|---|
| Automation/controller → Provisioner | Cloudflare Access Service Auth; one exact dedicated expiring Service Token | Request an approved host enrollment |
| Provisioner → GROUP | Dedicated private Service Binding and Provisioner-specific identity accepted only on that binding | Create a pending Worker and one-time challenge |
| Worker Agent → GROUP | One-time challenge redemption, then short-lived GROUP-signed Worker JWT | Enroll its server-issued identity and submit heartbeat |
| AMPHETAMIN → GROUP | Existing private Service Binding and principal assertion | Job API only; never Worker enrollment/admin |

The Access Service Token authenticates only the first boundary. It is never forwarded to GROUP, injected into a Worker Agent, used as a JWT signing key, or stored in D1.

GROUP must implement a separate `authorizeProvisioner()` path. The Provisioner caller marker is trusted only on its dedicated private Service Binding, never on public HTTP ingress. That binding must be exclusive to the dedicated Provisioner Worker. AMPHETAMIN assertions remain scoped to the existing Job API.

GROUP's current Access app remains default-deny. Do not add broad Allow policies or route enrollment through the AMPHETAMIN hostname.

## 3. Runtime topology and least privilege

Deploy a distinct Worker script, proposed name `symbiotyc-group-provisioner`, with its own entrypoint, `wrangler.jsonc`, CI/deployment target, and release/rollback procedure.

- Dedicated Access-protected hostname selected only after the Worker exists and its route is verified.
- One exact-token Service Auth policy; no owner-email, OAuth/DCR, or any-valid-service-token fallback.
- No D1 binding and no GROUP JWT signing-key binding.
- A read-only Secrets Store binding only for the Provisioner Access Client Secret if required by its downstream design; never expose it to Agents.
- One Service Binding to the exact GROUP script, used only for the internal enrollment API.
- Bounded body/rate limits, correlation IDs, redacted logs; never log authorization headers or challenge values.

The Provisioner maps its authenticated identity to a server-side allowlist of pools, providers, regions, and capacity ceilings. Tenant/project, trust class, capabilities, worker ID, and provisioner subject are derived from authenticated identity and server-side policy, never request-body fields.

No hostname or public route is selected here. No Cloudflare resource is created by this design.

## 4. API contract

### 4.1 Controller → Provisioner

`POST /v1/enrollments` requires dedicated Access Service Auth, an `Idempotency-Key` (8–128 safe ASCII characters, stable across retries), and JSON matching `contracts/provisioner-enrollment-request-v1.schema.json`.

The body declares only pool, provider, region, runtime, provider resource reference, and capacity. It rejects tenant/project/worker identity, registration epoch, trust class, capabilities, provisioner subject, and unknown fields. Provisioner authorization is resolved independently of the body.

### 4.2 Provisioner → GROUP

`POST /internal/v1/worker-enrollments` is reachable only over the dedicated GROUP Service Binding. GROUP resolves tenant/project/pool/trust/capabilities from server-side Provisioner policy and creates a server-generated worker ID and registration epoch, a `PENDING_ENROLLMENT` row, a short-lived one-time challenge (target TTL 5 minutes; only SHA-256 stored), and an audit event.

The response returns worker ID, epoch, challenge ID, challenge, and expiry once. Provisioner passes the challenge to the host through an approved host secret-injection channel. It must not log, persist in plaintext, or return the challenge to the controller.

Before enabling this endpoint, add a D1 request ledger with unique (provisioner subject, idempotency-key hash), request digest binding, and atomic commit with Worker, challenge, audit, and outbox. Same key/same digest resolves to the same enrollment; same key/different digest returns 409. After ambiguous delivery, do not disclose the challenge a second time; return redacted pending status and require explicit challenge rotation.

### 4.3 Worker Agent → GROUP

`POST /v1/workers/{worker_id}/enroll` accepts `contracts/worker-enrollment-proof-v1.schema.json`. GROUP verifies challenge hash, worker binding, expiry, unconsumed state, and current epoch.

Challenge consumption, Worker transition to ACTIVE, credential metadata, audit, and outbox commit atomically. Concurrent redemption has exactly one winner. On success, GROUP returns the short-lived Worker JWT once; the Agent stores it only in its protected local secret store. GROUP stores only credential hash/JTI/key metadata.

## 5. Worker JWT profile

- ES256 only; reject `none`, algorithm substitution, unknown `kid`, and malformed JOSE headers.
- Fixed deployment-configured GROUP issuer; audience `symbiotyc.compute.worker-heartbeat.v1`.
- Subject is server-issued `worker_id`; required claims: `registration_epoch`, `jti`, `iat`, `nbf`, `exp`.
- Target lifetime 5 minutes with bounded clock skew.
- Private signing key exists only in a GROUP Worker secret binding, never Provisioner, D1, Git, CI, or logs.
- Rotate with overlapping public verification keys by `kid`, activation/retirement times, and emergency revocation.
- Every heartbeat verifies signature, issuer/audience/time, subject, current JTI/revocation, Worker state, and epoch before mutation.

Access Service Token and Worker JWT are distinct credentials with distinct issuers, audiences, storage, and revocation lifecycles.

## 6. Persistence delta

Migration 0004 already provides `workers`, `worker_enrollment_challenges`, `worker_credentials`, `worker_heartbeats`, and `worker_audit_events`; migration 0005 provides database heartbeat fencing. They are storage constraints, not API authentication or credential issuance.

Add a migration-backed `worker_provisioning_requests` ledger with provisioner subject, hashed idempotency key, request SHA-256, worker ID, outcome state, timestamps, correlation ID, uniqueness, and retention policy. Ledger, Worker, challenge, audit, and outbox must commit atomically. In-memory idempotency and sequential non-atomic writes are forbidden.

## 7. Negative/acceptance tests

1. Missing, wrong, expired, disabled Service Token or wrong Access app is denied before handler effects.
2. Owner-email, OAuth/DCR, and any-valid-service-token do not grant access.
3. Unknown fields and caller-selected tenant/project/worker/epoch/trust/capabilities are rejected.
4. Unauthorized pool/provider/region/capacity requests are rejected.
5. Public HTTP cannot invoke the internal route, even with forged Provisioner headers.
6. AMPHETAMIN principal assertions cannot authorize enrollment; only the dedicated Service Binding identity is accepted.
7. Same idempotency key/same digest creates one Worker; same key/different digest returns 409.
8. Failure at Worker/challenge/audit/outbox writes leaves no partial state.
9. Expired, consumed, wrong-worker, wrong-epoch, malformed challenges are rejected; concurrent redemption has one winner.
10. JWT rejects bad signature, algorithm, kid, issuer, audience, subject, nbf, exp, JTI, epoch; revoked credentials fail immediately.
11. Provisioner Access token is never accepted as Worker JWT and Worker JWT is never accepted as Provisioner auth.
12. D1 transaction/fencing tests run against production-compatible D1; SQLite tests are not production proof.
13. Staging enrollment, heartbeat, rotation, drain, and revoke are evidenced before production eligibility.
14. Scheduler/dispatch remain disabled until separate acceptance gates pass.

## 8. Implementation order and state

- **I0.21:** runtime boundary audit — complete; deployment absent.
- **I0.22:** request/proof schemas and schema tests — committed; execution not yet verified.
- **I0.23:** D1 idempotency ledger migration and transaction tests.
- **I0.24:** isolated Worker entrypoint and deployment manifest scaffold committed; Access JWT verification, exact-token policy, GROUP private caller authentication, and deployment remain blocked/unimplemented.
- **I0.25:** Service Token provisioning through an explicitly supported secure workflow. I0.20's execution safety block remains in force; do not bypass it through another tool or route.
- **I0.26:** GROUP challenge redemption and ES256 JWT issuance/verification.
- **I0.27:** negative tests and staging acceptance.

No runtime code, migration, Cloudflare resource, Access policy, Service Token, secret, route, or Worker binding changed in this design step. GROUP remains default-deny; AMPHETAMIN unchanged; enrollment/heartbeat/Scheduler/dispatch disabled.


## I0.23 — durable idempotency ledger

Migration `0006_worker_provisioning_requests.sql` adds `worker_provisioning_requests` with a subject-scoped unique key on `(provisioner_subject, idempotency_key_hash)`, a fixed-length lowercase SHA-256 request digest, optional Worker foreign key, explicit PENDING/COMPLETED lifecycle, bounded outcome metadata, correlation ID, timestamps, and expiry index. Raw idempotency keys are not stored.

The enrollment handler must compare the stored request digest on every key replay: same subject/key and same digest resolves to the existing request; same subject/key with a different digest returns 409 without creating or mutating a Worker. The ledger row, Worker, challenge, audit, and outbox must commit in one D1 transaction. A PENDING row must never be committed as a partial enrollment. Completed rows are retained through `expires_at`; cleanup/retention execution remains a separate controlled operation and must not silently permit key reuse before expiry.

The migration is a schema artifact only. It has not been applied to production D1, and no enrollment route is enabled. SQLite schema smoke checks were executed for subject-scoped uniqueness, cross-subject isolation, hash validation, and Worker foreign-key enforcement; the repository's complete Python test module and D1 transaction/failure-injection suite have not been run.

**I0.23 status:** migration and focused test cases committed; production D1 application and D1-compatible atomicity proof remain outstanding.


## I0.24 — isolated runtime scaffold (quarantined)

The repository now contains:
- `provisioner/src/index.mjs` — isolated Worker entrypoint. It exposes a health response that reports `status=blocked` and `enrollment_enabled=false`; `POST /v1/enrollments` fails closed with `503 PROVISIONER_NOT_CONFIGURED`; all other paths return 404.
- `provisioner/wrangler.jsonc` — distinct Worker name and entrypoint, `workers_dev=false`, `preview_urls=false`, and a declared Service Binding named `GROUP` targeting `symbiotyc-group-control-plane`. It has no D1, KV, vars, secrets, signing key, or public route declaration.
- `tests/test_provisioner_runtime_layout.py` — static boundary checks for the isolated script, private binding declaration, absence of database/signing-key bindings, and fail-closed handler.

This is a repository scaffold, not a deployed Worker. A Service Binding in a manifest is not evidence that Cloudflare has provisioned the binding. The handler intentionally does not call `env.GROUP`: GROUP currently has no internal enrollment route or independently authenticated Provisioner authorization path. The Provisioner does not yet verify the Cloudflare Access JWT or resolve an allowlisted Provisioner subject. No trust is inferred from caller-supplied headers.

The runtime-layout tests were committed but not executed in this environment. No Cloudflare Worker, route, Access application/policy, Service Token, secret, or live binding was created or changed. I0.20's credential provisioning safety gate remains in force.

## I0.24.1 — independent Provisioner-to-GROUP authorization (verifier foundation)

GROUP now has a standalone verifier in `src/provisioner-auth.mjs`. It accepts only a compact Bearer JWT signed with ES256/P-256 by the dedicated Provisioner signing key and verifies it against a `kid`-indexed public-JWK set configured on GROUP. It does not inspect or trust `x-symbiotyc-caller`, `x-symbiotyc-principal`, or any caller-supplied identity marker. AMPHETAMIN remains a separate Job API principal and is rejected by the Provisioner subject check.

The assertion profile is deliberately narrow:
- exact JOSE header keys `alg=ES256`, `typ=JWT`, and bounded `kid`; algorithm substitution and extra header parameters are rejected;
- exact claims `iss`, `aud`, `sub`, `iat`, `nbf`, `exp`, `jti`, `rqh`, and `ikh`; unknown claims are rejected;
- issuer, audience, and subject must match the dedicated GROUP trust configuration;
- `rqh` is the SHA-256 digest of the canonical request envelope (HTTP method, internal path, and canonical validated body); `ikh` is the SHA-256 hash of the Idempotency-Key;
- JTI must be a UUID; assertion lifetime is at most 60 seconds with at most 5 seconds of clock skew;
- only a public P-256 JWK is accepted by GROUP; private key material is rejected.

The Provisioner assertion signing key is distinct from the Cloudflare Access Service Token and from GROUP's Worker JWT signing key. The private key belongs only to the isolated Provisioner runtime. GROUP receives only public JWK material, with overlapping `kid` entries used for controlled key rotation. The request ledger remains responsible for idempotent replay handling: same subject/key/digest resolves to the same request, while a different digest for the same key is a conflict.

**Implementation boundary:** this commit adds the verifier module and focused Node tests only. The internal enrollment HTTP route does not yet call it; GROUP's runtime trust variables/public key set are not configured; the Provisioner signing key is not provisioned; the isolated Worker is not deployed and its Service Binding is not live. Do not infer authorization readiness from this helper alone. No Access policy, Service Token, secret, Cloudflare binding, route, D1 migration, Worker deployment, or Scheduler/dispatch state changed. Public GROUP Access remains default-deny and AMPHETAMIN is unchanged.

**Verification:** the focused ES256 test cases cover valid assertion, forged caller marker, AMPHETAMIN subject, wrong audience, expiry, request-digest mismatch, idempotency-key mismatch, algorithm substitution, and invalid signature. The focused Node test was run locally on Node 22 and passed (5 top-level tests). This is not a full repository suite or Cloudflare Workers runtime verification.



## I0.26.1 — strict ES256 Worker JWT verifier core (2026-11-28)

Added `src/worker-jwt.mjs` with an isolated `verifyWorkerJwt()` primitive and `tests/worker-jwt.test.mjs`. The verifier is deliberately not wired to any HTTP route or runtime binding.

The primitive enforces:
- Compact three-part JOSE format, bounded token size, canonical base64url and JSON object segments.
- Exact JOSE header allowlist (`alg`, `typ`, `kid`) and strict claim allowlist; ES256 only; rejects `none`, algorithm substitution, unsupported header parameters, unknown key IDs, non-P-256/non-public/non-verification keys, and malformed 64-byte ES256 signatures.
- Cryptographic signature verification before accepting claims.
- Exact configured issuer and audience; required bounded subject/JTI; positive registration epoch; integer `iat`, `nbf`, `exp`; bounded clock skew; maximum 300-second lifetime and consistent time ordering.
- Mandatory durable credential resolver. The resolved record must be active and match subject, JTI, registration epoch, and key ID exactly; revoked/inactive and stale-epoch records fail closed.

Focused test coverage includes a valid token and negative cases for algorithm substitution, malformed JOSE, unknown `kid`,  invalid signature, issuer/audience mismatch, not-before/expiry/lifetime/future-issued times, malformed identity claims, revoked JTI, stale epoch, mismatched credential records, missing trust configuration/resolver, unsupported JOSE header parameters, and inconsistent time ordering.

**Verification:** the focused Node test file was executed in an isolated local working copy with Node 22.16.0: 15 tests passed, 0 failed. This is not a run of the full repository suite or deployed Cloudflare runtime. The test file is runnable with `node --test tests/worker-jwt.test.mjs` from the repository root. Existing Provisioner assertion verification remains a separate trust path and is not reused as a Worker credential verifier.

**Security boundary:** no signing key, public-key configuration, GROUP D1 resolver, Worker route, Provisioner route, Access policy, Cloudflare binding, or deployed runtime was changed. The verifier is not yet wired to a production D1 credential lookup. The private ES256 signing key remains unprovisioned. Enrollment, heartbeat, Worker eligibility, Scheduler, and dispatch remain disabled.

Next gate: implement the GROUP-side durable credential resolver against production-compatible D1 semantics and inject only a public-key set into the verifier; implement signing separately behind a GROUP-only write-only private-key binding, then add key-rotation overlap and transaction-boundary tests. Do not enable routes before these gates pass.


## I0.26.2 — D1-backed Worker credential resolver (2026-11-28)

Added `src/worker-credential-resolver.mjs` with `createD1WorkerCredentialResolver({ db, now })`. It uses the Cloudflare D1 prepared-statement interface (`prepare().bind().first()`) and the existing migration 0004 tables; no schema migration was added.

The lookup joins `worker_credentials` to `workers` using the server-issued Worker subject and requires an exact match on `token_jti`, `registration_epoch`, and `signing_key_id`. It additionally requires:
- Worker state `ACTIVE` or `DEGRADED`;
- Worker registration epoch equal to the credential epoch;
- `revoked_at IS NULL`;
- credential expiry later than server receive time (SQLite `julianday` comparison plus a defensive parsed-time check).

The resolver rejects extra/caller-supplied identity fields. Tenant and project identifiers are returned only from the joined D1 Worker row and are not accepted as resolver inputs. Missing rows return `null`; malformed identity, invalid clock, or D1 errors fail closed. The verifier's existing resolver contract remains compatible: the resolver returns `active`, Worker/JTI/epoch/key ID, and server-derived tenant/project context.

**Verification:** `node --test tests/worker-credential-resolver.test.mjs` was run in an isolated local working copy on Node 22.16.0: 8 passed, 0 failed. Tests cover the D1 binding contract, bound lookup parameters, required SQL predicates, tenant/project derivation, unknown credentials, revoked/expired/ineligible rows, identity mismatches, caller-supplied tenant rejection, and D1 failure. This is a focused adapter-contract test with a D1-shaped fake, not a live Cloudflare D1 integration test, production D1 migration proof, or full repository suite.

**Security boundary:** the resolver is not wired into `verifyWorkerJwt()`, any HTTP route, Provisioner, or deployed Worker. No D1 migration was applied, no Cloudflare binding/configuration or secret changed, and no key material was provisioned. Migration 0004's `worker_credentials` table is present in source; production D1 schema state has not been revalidated in this step. Enrollment/heartbeat, Worker eligibility, Scheduler, and dispatch remain disabled.

Next gate: add a production-compatible D1 integration test against the actual deployed D1 schema (including credential issuance/revocation lifecycle), then compose this resolver with the ES256 verifier behind a non-routed internal service boundary. Do not expose a heartbeat route or enable scheduling until D1 behavior, signing-key lifecycle, and transaction rollback gates pass.

## I0.24.2 — Provisioner ES256 assertion signer

Added `provisioner/src/provisioner-assertion.mjs` with `createProvisionerAssertion(env, input)`. The signer imports a P-256 PKCS#8 private key from the runtime secret `PROVISIONER_SIGNING_KEY_PKCS8` and emits a short-lived ES256 JWT matching GROUP's verifier profile. The module never exports or returns private key material.

The signed assertion contains the fixed issuer, audience, subject and key ID plus `iat`, `nbf`, `exp`, UUID `jti`, request digest `rqh`, and idempotency-key hash `ikh`. Lifetime is bounded to 1–60 seconds (default 45). Request digest is SHA-256 over deterministic canonical JSON containing the HTTP method, internal path, and validated request body; the idempotency key is hashed separately. The caller must pass the exact validated request envelope that it will send to GROUP. GROUP's future HTTP handler must independently canonicalize and hash the received method/path/body and hash the received Idempotency-Key; it must never accept client-supplied digest headers as authoritative.

Added `tests/provisioner-assertion.test.mjs` to the existing root Node test suite. It exercises signer→GROUP-verifier interoperability using ephemeral test keys, canonical JSON order stability, binding changes for method/path/body/idempotency key, missing key, invalid path, lifetime bounds, and non-disclosure of private JWK material. Test keys are generated only inside the test process and are not committed.

**Verification:** GitHub Actions run for the first test revision exposed one incorrect test expectation: changing only the idempotency key must change `ikh`, not `rqh`. The assertion was corrected and committed as `f1515ec2ea86e01a489e36e957373ac0dfbc63b3`. The workflow status for that corrected commit is pending at the time of this documentation update; do not treat the earlier failed run as a pass. The preceding run on the signer module without the root interoperability test passed, but it did not validate the full signer test file.

**Security/deployment boundary:** this is a code-level signer only. No PKCS#8 key has been generated or provisioned; no Worker secret has been created or bound; the signer is not wired into `provisioner/src/index.mjs`; no GROUP route calls the verifier; and no Cloudflare resource, Access policy, Service Token, D1 migration, deployment, or dispatch state changed. I0.20's secure credential provisioning gate remains in force. Enrollment and heartbeat remain disabled.


## I0.26.3 — resolver SQL verification against migration schema (2026-11-28)

Added `tests/test_worker_credential_resolver_sqlite.py`. The test extracts the exact `LOOKUP_SQL` template from `src/worker-credential-resolver.mjs`, initializes SQLite using repository migrations `0001_compute_core.sql`, `0004_worker_registry.sql`, and `0005_worker_heartbeat_fencing.sql`, seeds a Worker and credential, and executes the resolver query. It covers valid resolution, credential revocation, credential expiry, stale Worker epoch, ineligible Worker state, JTI/key mismatch, and server-side tenant/project derivation.

The integration test exposed an additional fail-closed edge case: the Worker row has its own `revoked_at` column. A corrupted/inconsistent row could otherwise have `state='ACTIVE'` while `revoked_at` was populated. The resolver now selects and rejects this field and adds `w.revoked_at IS NULL` to the SQL predicate. A regression test was first run RED (the resolver incorrectly returned the revoked Worker), then the fix was applied and the focused suite passed.

**Verification evidence:**
- `python -m unittest tests.test_worker_credential_resolver_sqlite -v`: 8 passed, 0 failed. Executed in an isolated local SQLite harness using the relevant DDL from migrations 0001/0004/0005. The committed test itself reads the complete repository migration files at runtime; this local run is not a Cloudflare D1 test and does not prove production schema application.
- `node --test tests/worker-credential-resolver.test.mjs`: 8 passed, 0 failed on Node 22.16.0 in an isolated local working copy.
- No full repository CI suite was run.

**Security boundary:** no production D1 query, migration, Cloudflare binding, secret, Access policy, Worker deployment, route, or scheduler configuration was changed. The resolver remains isolated and is not wired into `verifyWorkerJwt()`. Enrollment/heartbeat and Scheduler/dispatch remain disabled.

Next gate: run the committed SQLite integration test in the repository CI against the complete checked-in migration files, then perform a read-only schema inventory against the intended production D1 database. Do not enable routes until that evidence and the independent signing/key-rotation and transaction rollback gates exist.


## I0.24.3 — GROUP-side canonical request binding (2026-11-28)

Added `src/provisioner-request-binding.mjs` and made `verifyProvisionerAssertion()` derive the signed request binding from the actual inbound `Request`, rather than accepting digest values supplied by its caller.

The helper currently enforces the quarantined enrollment request boundary:
- exact `POST /internal/v1/worker-enrollments` method/path and no query string;
- a printable 8–128 character `Idempotency-Key`;
- `application/json` content type and a non-empty JSON object body;
- a 64 KiB body ceiling and bounded canonicalization depth;
- deterministic sorted-key JSON canonicalization matching the Provisioner signer;
- SHA-256 over the canonical `{method,path,body}` envelope and a separate SHA-256 over the actual received idempotency key.

The helper reads `request.clone()`, so the original body stream remains available to a future handler. The verifier ignores caller-supplied digest options and digest headers; only the recomputed values are compared with JWT claims `rqh` and `ikh`. The tests include deliberately forged digest headers, changed method/path/body, query strings, changed idempotency keys, malformed bodies and content types, and signer-to-verifier interoperability.

**Verification:** GitHub Actions on commit `001473f90f11d79b71accb411a456a39d7c5785e` completed successfully:
- Runtime unit tests, run #227 / ID `46154700766`: 85 passed, 0 failed.
- Compute protocol contracts, run #233 / ID `46154700753`: passed, including JSON syntax validation and schema conformance.

The first RED/GREEN iterations caught and corrected two test defects: a body mutation must produce a different digest (not make the parser reject a valid request), and the existing SQLite resolver test's SQL-extraction regex was over-escaped. The corrected code and tests are what the successful workflows exercised.

**Security/deployment boundary:** this is still a non-routed verification primitive. No enrollment route calls it; the helper does not mutate D1 or consume the request body seen by a future handler. No Service Token, secret, Access policy, binding, D1 migration, Worker deployment, or Scheduler/dispatch setting changed. I0.20 secure credential provisioning remains blocked; enrollment and heartbeat remain disabled.

Next: verify the runtime CI result, then add an isolated private-boundary composition test proving that the GROUP handler can authenticate the Provisioner and safely pass the same parsed body to validation without enabling a public route.


## I0.26.4 — read-only production D1 schema inventory (2026-11-28)

A read-only Cloudflare inventory identified the exact production database bound to the deployed GROUP Worker: `symbiotyc-group-control-plane` → binding `DB` (type `d1`) → `symbiotyc-group-compute-state` (version `production`, jurisdiction `eu`). The SQL query was served by the production primary in region `EEUR` (colo `FRA`).

The production `d1_migrations` ledger contains exactly:
1. `0001_compute_core.sql` — applied 2026-11-28 01:53:18.
2. `0002_runtime_ledger.sql` — applied 2026-11-28 01:53:18.
3. `0003_compute_approvals.sql` — applied 2026-11-28 01:53:20.

Direct `sqlite_master` inspection confirms the existing compute/runtime/approval tables and their indexes/triggers. It does **not** contain `workers`, `worker_credentials`, `worker_enrollment_challenges`, or `worker_heartbeats`, and no Worker Registry heartbeat-fencing triggers are present. Migrations `0004_worker_registry.sql`, `0005_worker_heartbeat_fencing.sql`, and `0006_worker_provisioning_requests.sql` are absent from the production migration ledger.

**Impact:** the D1-backed credential resolver from I0.26.2/3 cannot resolve production Worker credentials because its required Worker Registry tables are absent. This is a confirmed production schema gap, not a resolver test failure. Do not use the production resolver as an acceptance test until the required migrations are separately reviewed and applied.

**Read-only evidence:** all SQL was SELECT-only. Cloudflare query metadata reported `changed_db: false` and `rows_written: 0`; no migration, schema, data row, Worker binding, secret, route, deployment, or dispatch setting was changed. No production data rows were inspected.

**Gate:** production D1 schema is not ready for Worker credential resolution or transactional heartbeat. Registration/heartbeat remain absent/disabled; no Worker is schedulable; Scheduler/dispatch remain disabled. I0.20 credential-provisioning block remains independent and unchanged.

Canonical transaction gate: [F2.3 heartbeat transaction boundary](worker-heartbeat-transaction-boundary.md#i0264--read-only-production-d1-schema-inventory-2026-11-28).


## I0.26.5 — production D1 migration rollout review (2026-11-28)

**Review result: NOT APPROVED FOR PRODUCTION APPLICATION.** This is a source/schema review only. No migration, production D1 object, Worker binding, route, secret, deployment, or dispatch setting was changed.

### Target and migration order

The intended target remains the exact deployed binding established in I0.26.4: GROUP Worker `symbiotyc-group-control-plane`, binding `DB`, database `symbiotyc-group-compute-state`. Production currently records only migrations 0001–0003.

The reviewed dependency order is:
1. `0004_worker_registry.sql` — creates `workers`, capabilities, enrollment challenges, credentials, heartbeats and Worker audit tables; references `project_quotas(tenant_id, project_id)` from 0001.
2. `0005_worker_heartbeat_fencing.sql` — creates heartbeat admission and snapshot triggers on tables from 0004.
3. `0006_worker_provisioning_requests.sql` — creates the Provisioner idempotency ledger and references `workers(worker_id)` from 0004.

Do not reorder these migrations. 0005 depends on 0004; 0006 also depends on 0004. Apply only through the approved D1 migration mechanism, sequentially, after a separate explicit production-change authorization.

### Blocking source findings

**B1 — heartbeat trigger omits Worker revocation timestamp.** In 0005, both the BEFORE INSERT predicate and AFTER INSERT snapshot update require matching epoch and ACTIVE/DEGRADED state, but neither requires `workers.revoked_at IS NULL`. I0.26.3 deliberately added this independent guard to the credential resolver because state and revocation timestamp can be inconsistent. Align the trigger with that invariant before rollout; add a regression case with `state='ACTIVE'` and non-NULL `revoked_at`, proving that the heartbeat insert and snapshot update are rejected atomically.

**B2 — expired challenge can permanently occupy the one-unconsumed slot.** In 0004, partial unique index `worker_one_unconsumed_challenge` covers every row with `consumed_at IS NULL`; it does not exclude expired challenges. An expired, unconsumed challenge therefore blocks a replacement challenge for that Worker. Define an explicit expiry/supersession lifecycle and test replacement after expiry before applying the migration. Do not silently overload `consumed_at` to mean expired unless the contract is deliberately revised.

**B3 — provisioning request claims are not database-immutable.** In 0006, the unique key binds `(provisioner_subject, idempotency_key_hash)`, but no trigger prevents updates to `provisioner_subject`, `idempotency_key_hash`, or `request_digest`; no trigger constrains the state transition beyond the row CHECK. Add database-enforced immutable-claim and allowed-transition rules (PENDING → COMPLETED only, with completion fields consistent), or provide an equally strong transaction-boundary proof and explicit accepted risk. Include tests for changed digest/key/subject and illegal state transitions.

### Preflight checklist (read-only)

Before a separately approved rollout:
- Re-read deployed Worker settings and confirm the `DB` binding still resolves to the I0.26.4 database UUID; do not select a database by display name alone.
- Read `d1_migrations`; require exactly the expected baseline 0001–0003 and stop on unknown, partial, or divergent history.
- Inventory `sqlite_master` for collisions with every table/index/trigger name in 0004–0006; verify required 0001 parent table and composite primary key.
- Capture `PRAGMA table_info`, `index_list`, `foreign_key_list`, and trigger SQL for relevant baseline objects; run `PRAGMA foreign_key_check` where supported.
- Confirm a current recoverable D1 backup/restore procedure and its recovery-point implications with the platform owner before any DDL. If recovery cannot be demonstrated, do not proceed.
- Confirm the corrected migration files, their checksums, CI results, and migration runner behavior against a disposable D1-compatible test database.

### Apply and postflight acceptance criteria

After explicit authorization only, apply 0004, 0005, 0006 sequentially with no concurrent migration runner. Stop immediately on any error; do not manually mark a migration as applied or continue past a partial/ambiguous result.

Postflight must verify:
- migration ledger records 0001–0006 exactly once and in order;
- all expected Worker Registry tables, indexes, partial indexes and triggers exist with exact reviewed SQL;
- foreign-key integrity check returns no violations;
- revoked Worker, expired challenge replacement, replay/gap/stale epoch, over-capacity, and provisioning-ledger mutation negative cases fail closed;
- transaction failure injection in a disposable environment proves no partial heartbeat/audit/outbox or enrollment/request/challenge state;
- live production Worker still has no registration/heartbeat route or scheduler activation unless separately authorized.

### Recovery and rollback constraints

No down migrations are supplied or approved. Do not use destructive DROP-based rollback on production as a routine recovery method. Prefer a reviewed forward-fix for a faulty additive schema. A restore is a separate incident action requiring verified backup availability, restore semantics, acceptable data-loss window, and explicit authorization; this review does not claim that a production restore point has been tested.

**Decision:** HOLD. Resolve B1–B3 in migration source and tests, run CI plus disposable D1-compatible acceptance tests, and obtain a separate production migration authorization. I0.20 secure credential provisioning remains an independent blocker. Enrollment/heartbeat and Scheduler/dispatch stay disabled.

## I0.26.6 — quarantined enrollment request preparation (2026-11-28)

Added `src/provisioner-enrollment-schema.mjs` and `src/provisioner-enrollment-handler.mjs`. The preparation function composes the existing ES256 Provisioner assertion verifier with strict runtime validation of `contracts/provisioner-enrollment-request-v1.schema.json`.

The verifier now returns the exact parsed body from the request clone together with its server-computed `rqh` and `ikh`. The preparation function validates and returns that same parsed object; it does not re-read or re-parse the original body. The original Request body remains readable after preparation. Validation enforces the contract's required/optional properties, `additionalProperties: false`, enum values, string bounds, schema version pattern, nested runtime shape, and capacity bounds.

The function performs no D1 access or mutation and is not imported by `src/index.mjs`; no HTTP route has been added. It must only be composed behind the dedicated Provisioner Service Binding when that boundary is configured. A forged `x-symbiotyc-caller` marker cannot substitute for the signed ES256 assertion. This stage does not claim that the Service Binding origin itself has been cryptographically attested by this helper.

Tests cover valid and invalid signed requests, identity/trust field injection, invalid nested capacity/runtime, optional provider resource metadata, schema version rejection, forged AMPHETAMIN marker, preservation of the original body, and absence of DB binding access.

**Verification:** GitHub Actions on implementation/documentation commit `59340ff5d89e0770d389f09160b99fb4d9f25de6` passed:
- GROUP runtime tests, run #243 / ID `46155487464`: 94 passed, 0 failed.
- Compute protocol contracts/schema conformance, run #249 / ID `46155487501`: passed.

The first run for the initial implementation exposed the required-key iteration defect; it was fixed before the successful 94/94 run.

**Security boundary:** no route, D1 migration, D1 write, credential, secret, Access policy, binding, deployment, or dispatch state changed. I0.20 credential provisioning remains blocked. The production D1 migration HOLD from I0.26.5 remains in force; B1–B3 were corrected in I0.26.7, but production rollout still requires exact preflight, backup/restore readiness, disposable D1-compatible acceptance, and separate explicit authorization. Enrollment/heartbeat and Scheduler/dispatch remain disabled.


## I0.26.7 — Worker Registry migration security corrections (2026-11-28)

Corrected the three source-level blockers identified in I0.26.5:

- **B1 heartbeat revocation fencing:** migration 0005 now requires `workers.revoked_at IS NULL` in both the BEFORE INSERT admission predicate and AFTER INSERT snapshot update. A Worker with inconsistent `state='ACTIVE'` and a populated revocation timestamp cannot accept a heartbeat.
- **B2 challenge expiry lifecycle:** migration 0004 adds nullable `superseded_at`. The one-unconsumed-challenge unique index now applies only where both `consumed_at` and `superseded_at` are NULL. Before a replacement challenge is inserted, a trigger supersedes only an unconsumed, unsuperseded challenge whose `expires_at <= NEW.created_at`. A still-valid challenge continues to block replacement; expiry is not misrepresented as consumption.
- **B3 provisioning ledger integrity:** migration 0006 adds database triggers that freeze request identity, subject, idempotency hash, request digest, correlation, creation and expiry claims; allow only a complete PENDING → COMPLETED transition; prevent updates after completion; and prohibit deletion.

Regression tests cover revoked Worker heartbeat rejection with unchanged snapshot and no heartbeat row, replacement after challenge expiry, continued blocking by an unexpired challenge, immutable ledger claims, and valid/invalid state transitions. Test SQL fixtures were aligned with the new `superseded_at` column.

**Verification:** GitHub Actions on commit `495dde350a2b16ace442f4d293053550df03f178` passed:
- Runtime unit tests: run #285 / ID `46156096251`, 94 passed, 0 failed.
- Worker Registry migration/resolver SQLite tests: 22 passed.
- Credential resolver SQLite tests: 8 passed.
- Compute protocol contracts/schema conformance: run #291 / ID `46156096272`, passed.

Reviewed migration content SHAs:
- `0004_worker_registry.sql`: `561a6f27035a3b9398f561d8aaaa863e648c2137`
- `0005_worker_heartbeat_fencing.sql`: `61e8c79f8ab6f847808c99003647dab81d371adf`
- `0006_worker_provisioning_requests.sql`: `cebee8d68b73f270e3194ea964a4948750a8e263`
- Regression tests: `tests/test_worker_registry_migration.py` SHA `513e0a4076d149b959221a4ee22e64e4e22dda41`

This clears the source-level B1–B3 and CI gates only. It does not constitute a disposable D1-compatible acceptance run or production rollout approval. No production D1 migration was applied, no Cloudflare resource or secret changed, and no enrollment/heartbeat route or Scheduler/dispatch capability was enabled. Production decision remains **HOLD** pending disposable D1-compatible acceptance, verified backup/restore readiness, exact live preflight, and separate explicit authorization.


### I0.26.7 verification addendum

GitHub Actions verification completed successfully on implementation commit `25c9b2702998419d8ac9d63be0d8d8fc615dd957`:
- GROUP runtime + Worker Registry migration/resolver tests: run #276 / ID `46155964495`, success. Node runtime suite: 94 passed; `test_worker_registry_migration.py`: 20 passed; `test_worker_credential_resolver_sqlite.py`: 8 passed.
- Compute protocol/schema conformance: run #282 / ID `46155964423`, success.

The first Python CI attempt exposed a test-fixture timestamp issue in the PENDING → COMPLETED transition test. The fixture was corrected to advance `updated_at`; the successful run above validates the corrected commit. These tests execute against disposable in-memory SQLite databases initialized from the checked-in migrations, not the production D1 database.

**Result:** source-level B1–B3 blockers are addressed and the migration regression suites pass. Production rollout remains HOLD: no migrations have been applied to production D1, no live route/binding/secret has changed, and separate backup/restore readiness plus explicit production migration authorization are still required.
