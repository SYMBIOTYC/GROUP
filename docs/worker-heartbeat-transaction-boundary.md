# F2.3 — Transactional Heartbeat: Trust-Authority Blocker

**Status:** BLOCKED — implementation must not expose a heartbeat route until the independent Worker credential verifier and provisioner trust anchor exist.
**Reviewed:** 2026-11-28

## Evidence from current source

- `src/index.mjs` exposes only Job/approval routes. There is no Worker heartbeat route or Worker credential verification middleware.
- `authorize()` validates the private AMPHETAMIN Service Binding marker and its principal assertion. `docs/auth-service-contract.md` explicitly limits that assertion to the private AMPHETAMIN-to-GROUP boundary.
- The Worker identity contract requires a separate infrastructure Provisioner identity and a short-lived Worker credential bound to `worker_id` and `registration_epoch`.
- Migrations `0004` and `0005` provide storage and database fencing only. They do not authenticate a Worker, issue credentials, or create an HTTP service.
- The current route table has no independent Provisioner ingress or key-set/verifier configuration. Reusing AMPHETAMIN principal assertions would violate the trust separation.

## Blocking decision

Do not implement or expose `POST /v1/workers/{worker_id}/heartbeat` by calling the existing `authorize()` function. AMPHETAMIN is a Job API client, not an enrollment authority or Worker administrator.

The prerequisite is an independently authenticated Provisioner identity, with a documented issuer/subject mapping and deployment-controlled trust material. The Worker credential verifier must use a fixed algorithm allowlist, validate issuer/audience/time claims, bind `sub` to `worker_id`, check `registration_epoch`, `jti`, expiry and revocation, and fail closed when key material or credential state is unavailable. Private signing material must remain in deployment secrets, never D1 or Git.

## F2.3 implementation contract after prerequisite I0

Once the independent trust authority is deployed and verified, implement the heartbeat service in this order:

1. Verify the signed short-lived Worker credential before any state mutation.
2. Resolve the Worker by the credential subject and enforce current epoch, credential/JTI state, and tenant/project binding from server-side records.
3. Validate the bounded heartbeat payload; ignore caller-supplied tenant, project, trust class, pool, and identity fields.
4. Use server receive time to derive `received_at` and lease expiry. Require the next monotonic heartbeat sequence.
5. In one atomic D1 batch/transaction, insert the heartbeat (letting migration 0005 enforce epoch, sequence, state and capacity), append `HEARTBEAT_ACCEPTED` audit, and append a versioned outbox event. Ensure each later write is conditional on the preceding accepted mutation; any failure must roll back the whole batch.
6. Read back the committed Worker snapshot and return only the bounded accepted state.

The service must reject invalid signature/claims, wrong audience/issuer, expired/not-yet-valid token, revoked/unknown JTI, stale epoch, sequence replay/gap, inactive Worker, over-capacity observation, and cross-tenant/project binding. A rejected heartbeat must not advance the lease, snapshot, audit, or outbox.

## Required tests

- Valid credential + current epoch + next sequence commits heartbeat, snapshot, audit and outbox together.
- Invalid signature, issuer, audience, `nbf`, or `exp` causes zero writes.
- Revoked/unknown JTI and stale epoch cause zero writes.
- Duplicate, stale, or skipped sequence causes zero writes.
- Inactive/revoked Worker and over-capacity observation cause zero writes.
- Audit or outbox insert failure rolls back the heartbeat and lease snapshot.
- Tenant/project values in the payload cannot select or mutate another Worker.
- Credential-verifier unavailability fails closed; no fallback to AMPHETAMIN assertion.

## Release gate

**I0 — Provisioner trust authority:** BLOCKED until the independent identity issuer, trust configuration, key rotation/revocation procedure, and authenticated enrollment path are deployed and verified.

Until I0 passes: registration and heartbeat endpoints remain absent/disabled; no Worker becomes eligible; Scheduler and dispatch remain disabled. SQLite migration tests are not proof of Cloudflare D1 production behavior, and no CI result is claimed by this design record.
