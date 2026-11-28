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
- Exact JOSE header allowlist (`alg`, `typ`, `kid`); ES256 only; rejects `none`,  algorithm substitution, unsupported header parameters, unknown key IDs, non-P-256/non-public/non-verification keys, and malformed 64-byte ES256 signatures.
- Cryptographic signature verification before accepting claims.
- Exact configured issuer and audience; required bounded subject/JTI; positive registration epoch; integer `iat`, `nbf`, `exp`; bounded clock skew; maximum 300-second lifetime and consistent time ordering.
- Mandatory durable credential resolver. The resolved record must be active and match subject, JTI, registration epoch, and key ID exactly; revoked/inactive and stale-epoch records fail closed.

Focused test coverage includes a valid token and negative cases for algorithm substitution, malformed JOSE, unknown `kid`,  invalid signature, issuer/audience mismatch, not-before/expiry/lifetime/future-issued times, malformed identity claims, revoked JTI, stale epoch, mismatched credential records, missing trust configuration/resolver, unsupported JOSE header parameters, and inconsistent time ordering.

**Verification:** the focused Node test file was executed in an isolated local working copy with Node 22.16.0: 13 tests passed, 0 failed. This is not a run of the full repository suite or deployed Cloudflare runtime. The test file is runnable with `node --test tests/worker-jwt.test.mjs` from the repository root. Existing Provisioner assertion verification remains a separate trust path and is not reused as a Worker credential verifier.

**Security boundary:** no signing key, public-key configuration, GROUP D1 resolver, Worker route, Provisioner route, Access policy, Cloudflare binding, or deployed runtime was changed. The verifier is not yet wired to a production D1 credential lookup. The private ES256 signing key remains unprovisioned. Enrollment, heartbeat, Worker eligibility, Scheduler, and dispatch remain disabled.

Next gate: implement the GROUP-side durable credential resolver against production-compatible D1 semantics and inject only a public-key set into the verifier; implement signing separately behind a GROUP-only write-only private-key binding, then add key-rotation overlap and transaction-boundary tests. Do not enable routes before these gates pass.
