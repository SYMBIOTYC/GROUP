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
