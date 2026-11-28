# Provisioner Runtime and Enrollment Boundary v1

**Status:** normative design contract; implementation blocked by I0.20/I0.21  
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
- **I0.24:** standalone Provisioner Worker and private GROUP Service Binding authorization.
- **I0.25:** Service Token provisioning through an explicitly supported secure workflow. I0.20's execution safety block remains in force; do not bypass it through another tool or route.
- **I0.26:** GROUP challenge redemption and ES256 JWT issuance/verification.
- **I0.27:** negative tests and staging acceptance.

No runtime code, migration, Cloudflare resource, Access policy, Service Token, secret, route, or Worker binding changed in this design step. GROUP remains default-deny; AMPHETAMIN unchanged; enrollment/heartbeat/Scheduler/dispatch disabled.
