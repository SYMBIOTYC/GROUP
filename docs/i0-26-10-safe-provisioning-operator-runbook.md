# I0.26.10 — Safe Provisioning Operator Runbook

**Date:** 2026-11-28  
**Decision:** DOCUMENTATION READY / EXECUTION BLOCKED  
**Scope:** Operator procedure and acceptance contract only. This document does not authorize Service Token creation, secret capture, Access policy mutation, Worker deployment, D1 migration, enrollment, heartbeat, scheduling, or dispatch.

## 1. Current verified baseline

The I0.26.9 read-only inventory established:

- GROUP Access application: `2db93e50-e75b-4674-b55e-47631a2b7acf`, domain `symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev`.
- GROUP Access application currently has zero policies (default-deny).
- Account Access Service Token inventory: zero.
- `default_secrets_store` exists but contains zero secrets.
- `symbiotyc-group-provisioner` is not deployed (Worker settings GET returned 404 / error 10007).
- The repository Provisioner scaffold is source-only. Its manifest has `workers_dev=false`, `preview_urls=false`, and one service binding named `GROUP` targeting `symbiotyc-group-control-plane`.
- Production D1 remains on migrations 0001–0003; 0004–0006 are not applied.
- I0.20 remains blocked because no approved one-time secret capture and secure handoff interface is available.

No step below should be interpreted as evidence that the corresponding account resource already exists.

## 2. Hard security invariants

1. Never place a Service Token client secret, Access credential, signing private key, or other secret in chat, Git, issue/PR text, D1, environment dumps, shell history, logs, screenshots, or ordinary tool output.
2. Do not create a token until the operator-approved one-time capture interface has been demonstrated end-to-end, including secure delivery to the intended secret store and confirmation that the value is not echoed or logged.
3. A token ID is metadata, not the client secret. Record only the token ID, name, creation/expiry timestamps, intended consumer, and rotation/revocation owner.
4. Use one dedicated, narrowly scoped, time-bounded Service Token for this Provisioner trust relationship. Do not reuse AMPHETAMIN credentials or a human identity.
5. The Access application remains default-deny. The only intended allow path is a Service Auth policy whose Include selector matches the exact newly created Service Token ID. No broad email, Everyone, IP, country, or generic service-token selector is acceptable.
6. Provisioner must have no public route, workers.dev hostname, preview URL, D1 binding, KV/R2 binding, or unrelated service binding. Its only service binding is the private `GROUP` binding.
7. Caller-supplied tenant, project, Worker identity, trust class, pool, capabilities, or credential claims never establish authority. GROUP resolves identity and authorization from verified server-side records.
8. Fail closed on missing configuration, invalid Access assertion, invalid Provisioner assertion, stale/replayed idempotency claim, unavailable key material, or GROUP authorization failure.
9. Observability must not record request authorization headers, Access client secret, private key material, enrollment proof, raw challenge, or Worker bearer credential. Disable or redact body/header capture before any authenticated test.
10. Provisioner trust provisioning and production D1 rollout are separate approvals.

## 3. Gate A — approve and prove the secret-capture interface

**Do not proceed to token creation until every item passes.**

The operator/security owner must identify an approved interface that:
- receives the one-time client secret directly from the Cloudflare creation flow;
- writes it directly into the approved secret manager / Cloudflare secret destination without routing through this chat, a transcript, a CI log, a terminal transcript, or an untrusted clipboard;
- exposes only a success/failure receipt and non-secret metadata to the operator;
- does not offer a read-back operation that prints the secret;
- has a documented access-control boundary, audit trail, and recovery/rotation owner.

Perform a dry run with a non-production test value if the interface supports it. Verify that the value is absent from logs, command history, chat, CI artifacts, and diagnostic output. Record the interface name, owner, test date, and evidence reference; never record the value.

**Stop condition:** if any part of the capture path is unavailable, untested, or would expose the secret to ordinary tool output, stop. Do not create the Service Token. This is the current I0.20 blocker.

## 4. Gate B — create the Service Token (only after Gate A approval)

1. In the Cloudflare Zero Trust account, create a dedicated Service Token for the GROUP Provisioner trust relationship.
2. Set a bounded lifetime. The current design target is 90 days (`2160h`); if account policy requires a shorter duration, use the shorter duration and record it. Do not create a non-expiring token.
3. Use a descriptive name identifying the Provisioner consumer and environment. Do not include a secret or sensitive tenant data in the name.
4. Capture the one-time client secret directly through the approved interface from Gate A into the approved secret destination. Do not copy it into chat, Git, a PR, terminal output, or a local file.
5. Record only non-secret metadata: token ID, token name, creation time, expiry time, destination secret identifier, owner, and rotation/revocation procedure.
6. Read back the token inventory and confirm exactly one intended token exists, its expiry is correct, and its metadata matches the change record. Never read back the client secret.
7. Confirm that no existing AMPHETAMIN Service Token or policy was modified.

**Stop condition:** if the secret capture receipt is ambiguous, the token metadata cannot be matched, or the secret may have been exposed, revoke the token and treat the event as a security incident. Do not proceed using an uncertain credential.

## 5. Gate C — Access application policy

Target application is the existing GROUP Access application identified in section 1. Preserve its default-deny posture.

Create one narrowly scoped policy with the following intended semantics:

- Application: the exact GROUP Access application ID above.
- Policy action: `Service Auth`.
- Include selector: `Service Token` with the exact token ID created in Gate B.
- Exclude/Require: none unless a separately reviewed control requires them; do not broaden the Include selector.
- No wildcard, Everyone, email identity, IP range, country, or all-service-token selector.
- No change to the AMPHETAMIN Access application.

After creation, read back the application and policy metadata. Verify application ID/domain, policy ID/name, action, exact token ID selector, enabled state, and absence of additional allow policies. Do not retrieve or print client secret values. Run an anonymous request and confirm it remains denied/intercepted; a token-specific allow policy must not turn the application into a public endpoint.

If the Cloudflare policy model or API response does not represent the exact token ID selector unambiguously, stop and obtain a reviewed policy design rather than substituting a broader selector.

## 6. Gate D — Provisioner deployment and private Service Binding

The source scaffold is `provisioner/`; its current manifest declares:

- Worker name: `symbiotyc-group-provisioner`.
- `workers_dev=false`.
- `preview_urls=false`.
- One service binding: `GROUP` → `symbiotyc-group-control-plane`.

Before deployment, review the exact commit and generated deployment diff. Confirm:

1. No public route, custom domain, workers.dev hostname, or preview URL is configured.
2. The only service binding is `GROUP` to the exact GROUP Worker service.
3. No D1, KV, R2, Durable Object, queue, or unrelated service binding is present.
4. No secret is embedded in `wrangler.jsonc`, source, vars, build output, or deployment arguments.
5. The Access-protected ingress and Provisioner-to-GROUP request authentication are distinct controls. An Access-authenticated request alone is not proof of the Provisioner's signed, request-bound assertion.
6. GROUP validates the Provisioner assertion, issuer/audience/key ID, time bounds, subject, canonical request binding, and replay/idempotency constraints independently.
7. Health/readiness is fail-closed when required secret bindings, verification keys, or service configuration are absent.
8. Enrollment is not enabled merely because the Worker deploys. No public enrollment or heartbeat route is introduced.

Deploy only after Gates A–C and code/config review are explicitly approved. After deployment, read back Worker settings and service bindings. Confirm the Worker exists, `workers_dev=false`, preview URLs are disabled, no routes/domains are attached, and the private GROUP binding resolves to the intended service. A successful deployment is not a successful trust integration.

## 7. Gate E — secret bindings without value disclosure

Bind only the minimum required runtime secrets using the approved secret manager / secret-binding mechanism. Secret names and identifiers must be documented separately from values.

Verification must be metadata-only:
- list binding names and binding types;
- confirm each required name is present exactly once;
- confirm no unexpected secret binding exists;
- confirm the binding belongs to the intended Provisioner environment/version;
- inspect deployment metadata/configuration, not secret values;
- execute a runtime presence check that returns only a boolean or stable non-sensitive error code.

Never call a secret read/list-values endpoint, print environment variables, dump the Worker environment, echo headers, or add a diagnostic route that returns secret material. Do not treat a secret count or successful write response as proof that the intended Worker version has the binding; verify the binding metadata on the deployed Worker version.

Required binding inventory must be finalized by the implementation review before this gate. Do not invent placeholder secret names or bind speculative keys. In particular, no signing private key should be introduced until its key-generation, custody, rotation, and public-key publication contract is approved.

## 8. Gate F — authenticated and negative integration tests

Run first against an isolated non-production test environment with synthetic identities and credentials. Capture only request IDs, status codes, stable error codes, and non-sensitive state assertions.

### Positive path
- Valid Access Service Token is accepted by the GROUP Access application.
- A valid Provisioner-signed assertion is independently verified by GROUP.
- Assertion is bound to the exact HTTP method, path, body digest, idempotency key, audience, issuer, subject, key ID, and bounded time window defined by the contract.
- Valid request reaches GROUP only over the private Service Binding.
- GROUP resolves tenant/project and Provisioner subject from trusted records; no caller-supplied identity is authoritative.
- One valid idempotent enrollment intent produces one durable outcome; an identical retry returns/reconciles the same outcome without duplicate Worker creation.
- Health/readiness reports ready only when all required configuration and trust dependencies are present.

### Mandatory negative paths
- Missing Access credentials; wrong token; revoked/expired token.
- Missing, malformed, wrong-issuer, wrong-audience, expired, not-yet-valid, unknown-kid, or invalid-signature Provisioner assertion.
- Assertion replay; stale timestamp; request method/path/body/idempotency-key mismatch.
- Caller attempts to override tenant, project, Worker ID, trust class, pool, capabilities, or registration epoch.
- Reuse of an idempotency key with a different request digest.
- Duplicate concurrent enrollment request; timeout/unknown outcome followed by retry.
- Missing secret binding, missing verification key, malformed configuration, unavailable GROUP binding.
- Attempt to reach Provisioner through public hostname, preview URL, or unconfigured route.
- Attempt to invoke GROUP directly from an unauthorized identity or without the private caller assertion.

For every rejected request, assert no Worker, challenge, credential, provisioning-request outcome, audit event, or outbox side effect is committed unless the contract explicitly defines a durable rejected-attempt audit record. Verify that any such audit record contains no credential or secret material. Confirm no partial transaction or duplicate enrollment occurs.

### Evidence and pass criteria
- Test environment and exact commit/deployment version identified.
- Positive path passes.
- Every negative case passes with the expected deny/fail-closed behavior.
- State-before/state-after assertions prove no unauthorized mutation.
- Logs and traces inspected for secret/header/body leakage using synthetic canary values; no secret value appears.
- Results are reproducible and attached to the implementation PR as sanitized evidence.
- No test is described as production proof unless it actually ran against the identified production service and was separately authorized.

## 9. Gate G — production D1 rollout admission (independent)

Provisioner acceptance does not authorize production D1 migration. Migrations 0004–0006 remain HOLD until all of the following are independently satisfied:

1. Separate explicit production D1 rollout authorization is recorded.
2. Live GROUP Worker `DB` binding and database UUID are re-resolved immediately before the change.
3. Production migration ledger is re-read and confirms the expected baseline (currently 0001–0003 as of I0.26.9).
4. An independent durable backup exists outside the source database; temporary Cloudflare export completion alone is insufficient.
5. Backup object metadata, byte length, SHA-256, retention/immutability, access controls, and recovery owner are verified without exposing signed URLs or SQL contents.
6. Restore/import rehearsal completes against the separately authorized disposable EU D1 restore target, not production. Record restore duration, schema parity, row-count/integrity checks, foreign-key checks, and measured recovery point.
7. Corrected migrations 0004, 0005, and 0006 are reviewed in order and validated against the exact production-compatible D1 behavior; local Wrangler/Miniflare tests are supporting evidence, not a substitute for backup/restore proof.
8. Preflight confirms no object collisions, expected parent keys, foreign-key integrity, and exact target database.
9. A stop-on-first-error execution plan, operator, monitoring window, and forward-recovery procedure are approved. No manual migration-ledger edits or speculative destructive rollback.
10. Postflight verifies migration ledger order, tables/indexes/triggers, FK integrity, B1–B3 regressions, and atomic rollback/failure behavior.
11. Worker enrollment/heartbeat route activation and Scheduler/dispatch remain separately gated; applying schema does not enable them.

**Current D1 status:** HOLD. The latest recorded backup work does not establish an independently retained, checksum-verified backup and completed restore rehearsal. Therefore this runbook grants no D1 rollout approval.

## 10. Revocation, rotation, and incident response

- Revoke the dedicated Service Token immediately if exposed, ownership is uncertain, the capture path is compromised, or the Provisioner is retired.
- Remove/disable the token-specific Access policy before or during containment; verify default-deny readback.
- Replace credentials only through the approved capture path. Never overwrite a secret by copying it through chat or logs.
- Rotate signing keys under an explicit overlapping-key procedure with `kid` tracking and bounded retirement. Do not revoke an active verification key until dependent credentials are safely migrated or invalidated.
- Disable Provisioner deployment/binding if its identity or runtime integrity is uncertain.
- Preserve sanitized audit evidence; do not preserve raw credentials, bearer headers, enrollment proofs, or private keys.
- Re-run positive and negative integration tests after rotation and policy changes.

## 11. Operator sign-off record (metadata only)

Record:
- change/ticket ID and approval references;
- operator and security reviewer;
- secret-capture interface name, owner, and test evidence reference (never its payload);
- Service Token ID/name/expiry (never client secret);
- Access application ID, policy ID/action, and exact token ID selector;
- Provisioner commit, deployed version, private binding target, and route/preview readback;
- secret binding names/types and metadata-only verification result;
- sanitized integration test report and test environment;
- D1 backup/restore evidence and separate rollout authorization, if later approved.

## 12. Current disposition

**I0.26.10 documentation is prepared. Execution remains BLOCKED at Gate A.** No Service Token or secret has been created or captured; no Access policy has been added; Provisioner is not deployed; no secret binding has been changed; no authenticated integration test has been run; production D1 is unchanged and migrations 0004–0006 remain unapplied. Enrollment/heartbeat, Worker eligibility, Scheduler, and dispatch remain disabled.

Related contracts: [Provisioner runtime contract](provisioner-runtime-contract.md), [Worker identity and enrollment contract](worker-identity-and-enrollment-contract.md), [Transactional heartbeat boundary](worker-heartbeat-transaction-boundary.md).
