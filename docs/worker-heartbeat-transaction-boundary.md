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


## I0 account-side audit — 2026-11-28

A read-only inventory of the linked Cloudflare **Primary** account was performed. No secret values were requested or read.

- Account-level Access Service Token inventory returned an empty list.
- The only Access application returned was `SYMBIOTYC AMPHETAMIN MCP`, with an owner-email allow policy and OAuth/DCR configuration. No dedicated Provisioner Access application was present.
- Worker secret-binding metadata for `symbiotyc-group-control-plane` returned an empty list.
- GROUP's deployed Worker settings exposed only the `DB` D1 binding; no JWT signing/verifier secret binding was present.
- The AMPHETAMIN Worker had the private `GROUP` Service Binding and `RUNTIME_DB`, but no Worker secret bindings in the inspected metadata.
- The deployed Worker inventory contains GROUP and AMPHETAMIN, but no separately named Provisioner Worker.

This is account-side configuration evidence for the inspected Primary account at the review date. It does not prove that no external identity provider exists outside this Cloudflare account, but none is configured in the inspected GROUP Worker bindings or Access inventory.

## I0 decision and next implementation boundary

There is currently no configured Cloudflare Access Service Token to authenticate an infrastructure Provisioner, and no signing/verifier secret binding on GROUP. Therefore no enrollment credential can be issued or verified safely in the current deployment.

Candidate architecture, pending an explicit provisioning decision:

- A dedicated, narrowly scoped Cloudflare Access self-hosted application and service token may authenticate the Provisioner-to-enrollment control path. It must be separate from the AMPHETAMIN Access application and its user OAuth/DCR policy.
- The Worker Agent credential remains a separate short-lived signed credential, issued only after authorized one-time enrollment. A Provisioner Access Service Token must never be copied to Workers or treated as a Worker heartbeat credential.
- GROUP's signing key and any verifier trust configuration must be deployed through Worker secret bindings. Secret values must be entered through the authorized secure interface; never paste them into chat, Git, D1, or logs.

No Access application, service token, Worker secret, or production binding was created or changed during this audit. Creating/rotating a service token or entering a signing secret is a privileged credential operation and requires explicit authorization through the secure account interface.

**I0 remains BLOCKED.** The immediate next action is to provision the dedicated Provisioner identity and secure credential delivery path; only then can enrollment and Worker JWT verification be implemented.


## I0.2 — Provisioning runbook and API constraints

The Cloudflare API schema was inspected read-only before provisioning:

- Account Access API supports creating a dedicated self-hosted Access application and creating an account-level Access Service Token.
- Service-token creation returns the Client Secret only once. If it is lost, the documented recovery is rotation or creating a replacement token. Therefore the secret must be captured directly into an approved secret manager/secure provisioning interface at creation time; it must not transit through chat, GitHub issues, D1, shell history, or logs.
- Worker script secret bindings are write-only on creation and can be enumerated by binding name only. GROUP's current Worker has no such binding.
- No endpoint or configuration was changed during this planning step.

### Ordered provisioning sequence

1. Approve a dedicated Access application name and a dedicated enrollment hostname/path. Do not reuse `symbiotyc-amphetamin-mcp` or its OAuth/DCR settings.
2. Create a self-hosted Access application with a default-deny posture and an explicit Service Auth policy that includes only the dedicated Provisioner service token. Do not add owner-email, broad identity-provider, or user OAuth grants as a substitute for machine identity.
3. Create a named, expiring Service Token for the Provisioner. Prefer a bounded lifetime (for example 90 days) rather than `forever`; document owner, rotation date, and emergency revocation procedure. Confirm the exact allowed duration and policy schema at execution time.
4. Capture the one-time Client Secret directly in the approved secret manager or secure target configuration. The token must be sent only as the Cloudflare Access service-token headers from the Provisioner; it must never be available to Worker Agents.
5. Add a dedicated Provisioner authentication binding to GROUP only after the application and token are active. Keep Access authentication distinct from Worker JWT issuance.
6. Define the Worker signing model separately. Prefer asymmetric signing so GROUP stores only the private signing key and exposes a public verification key/JWKS to Worker-facing verification components; keep `kid`, rotation overlap, revocation, and issuer/audience fixed in the contract. Do not reuse the Access Service Token as JWT signing material.
7. Verify with a non-production enrollment probe and negative tests (missing headers, wrong token, expired/disabled token, wrong audience/issuer, invalid JWT, revoked JTI) before enabling any production enrollment endpoint.

### Execution guard

This runbook is design-only. Creating the Access app, policy, token, or Worker secret changes account security posture and creates credentials. Those actions require explicit approval and secure credential handling. Until those steps are completed and verified, I0 remains blocked and Worker registration/heartbeat remain unavailable.


## I0.3 — Enrollment hostname prerequisite audit

A further read-only audit of the Cloudflare Primary account found **zero active or pending zones** associated with that account. The inspected GROUP and AMPHETAMIN Worker settings also expose no custom-domain or route binding in their current settings snapshots; GROUP remains bound only to D1 `DB`, while AMPHETAMIN has its existing private GROUP Service Binding and runtime bindings.

Consequences:

- There is no verified customer-controlled zone in this account on which to reserve a dedicated enrollment hostname or attach a zone-scoped Worker route.
- Do not guess a hostname, create a zone, or place the Access app on the existing AMPHETAMIN hostname.
- Before Access application creation, the owner must identify an already-controlled domain/zone and approve a dedicated hostname (for example, `provisioner.<approved-zone>`), or explicitly authorize adding a domain/zone and completing its DNS onboarding.
- Until then, the Access application domain and Worker route target are unresolved. No Cloudflare resources were changed.

This is an additional I0 prerequisite, not a reason to expose the current GROUP Worker publicly.


## I0.4 — Free enrollment hostname selected

The Cloudflare Primary account already has the Workers subdomain `vladyslavchaplygin.workers.dev` (confirmed by the account's Workers Subdomain GET endpoint). Cloudflare's Workers Access documentation explicitly supports hostname-based Access protection for a `workers.dev` hostname by creating a self-hosted Access application.

Candidate enrollment origin:

`https://symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev`

This is a candidate, not yet a verified live URL: the current Worker inventory/settings response does not expose an authoritative `workers_dev` enablement flag, so reachability must be probed before creating Access policy or publishing enrollment routes. The exact host is reserved for the GROUP control plane; do not reuse the AMPHETAMIN hostname.

No Worker settings, Access applications, policies, or tokens were changed in this step. The account's Workers subdomain already exists, so no new domain or DNS zone is required. The remaining privileged step is Access application + default-deny/Service Auth policy provisioning, followed by a one-time Service Token secret handoff into the future dedicated Provisioner Worker through an approved secure secret-entry path. Do not create a token until that secret handoff path exists.


## I0.5 — Hostname and Access preflight (read-only)

Cloudflare account API confirms the account Workers subdomain remains `vladyslavchaplygin.workers.dev`. The account Access application inventory contains only the existing `SYMBIOTYC AMPHETAMIN MCP` application at `symbiotyc-amphetamin-mcp.vladyslavchaplygin.workers.dev`; there is no dedicated `SYMBIOTYC PROVISIONER` application.

The GROUP Worker settings response exposes only its D1 `DB` binding and does not return an authoritative `workers_dev` enablement field. An external HTTP open attempt against the candidate GROUP hostname was inconclusive (the inspection client returned an internal access error, not an origin HTTP status). Therefore candidate hostname reachability is **not verified**.

No Access application, policy, token, Worker setting, or route was created or modified. Do not create Access against the candidate hostname until a real origin-level probe confirms the hostname resolves to the intended GROUP Worker. Keep AMPHETAMIN Access untouched.

## I0.6 — workers.dev routing semantics (read-only, 2026-11-28)

A fresh Cloudflare API read of the deployed GROUP Worker returned `routes: null`, with no custom route attached. The Worker list response does not expose a `workers_dev` flag, and the Workers API schema has no per-script settings endpoint that returns this flag. Account-level Workers settings also do not contain a `workers_dev` control.

Cloudflare's current documentation states that a Worker is assigned a `workers.dev` route by default when created or renamed, and Wrangler defaults `workers_dev` to `true` when neither `route` nor `routes` is configured. It also documents that the route can be explicitly disabled from the dashboard (Workers & Pages → Worker → Settings → Domains & Routes → workers.dev → Disable), so `routes: null` alone is not conclusive proof of current enablement.

References:
- https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- https://developers.cloudflare.com/workers/wrangler/configuration/

The candidate URL remains `https://symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev`. The inspection client still cannot provide an origin HTTP response for that URL; reachability and explicit dashboard state remain unverified. Do not change Worker settings or deploy solely to force the route. The next safe verification is to inspect the Worker in Cloudflare Dashboard → Settings → Domains & Routes and confirm the `workers.dev` entry is enabled, then perform an origin-level HTTPS probe. Only after that should the dedicated Access app be considered; do not modify the AMPHETAMIN app or expose enrollment routes.

No Cloudflare resource was changed. I0 remains BLOCKED.

## I0.7 — Exact GROUP workers.dev state (read-only, 2026-11-28)

The Cloudflare API's dedicated Worker Subdomain endpoint was queried for `symbiotyc-group-control-plane` using GET `/accounts/{account_id}/workers/scripts/{script_name}/subdomain`. It returned:

```json
{"enabled":false,"previews_enabled":false}
```

This is authoritative per-script state: the GROUP Worker `workers.dev` hostname is currently disabled. The candidate URL `https://symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev` must therefore not be treated as reachable. This resolves the earlier uncertainty in I0.5/I0.6; those entries record the evidence available at their review times.

No configuration was changed. Enabling `workers.dev` is a production exposure/configuration change and requires explicit owner authorization. Do not enable preview URLs. After authorization and enablement, verify the exact hostname with an origin-level HTTPS probe, then configure a dedicated default-deny Access application before any enrollment endpoint is introduced. Keep the AMPHETAMIN Access application untouched. I0 remains BLOCKED.

## I0.8 — GROUP workers.dev enabled (2026-11-28)

The owner explicitly authorized enabling the GROUP Worker on the account existing `workers.dev` subdomain while keeping Preview URLs disabled. Cloudflare POST `/accounts/{account_id}/workers/scripts/{script_name}/subdomain` was executed with `{ enabled: true, previews_enabled: false }`. The API returned success, and an immediate independent GET read-back confirmed:

```json
{"enabled":true,"previews_enabled":false}
```

The hostname is `https://symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev`. This change enables public workers.dev routing only; it does not add an Access application, Service Auth policy, Provisioner token, Worker secret, or enrollment/heartbeat route. AMPHETAMIN configuration was not changed. I0 remains BLOCKED; no Worker is schedulable and Scheduler/dispatch remain disabled.

An external origin probe through the available web inspection client returned an internal inspection error rather than an origin HTTP status. A separate runtime DNS probe could not resolve the hostname because the execution environment DNS lookup failed. Therefore HTTP reachability is not yet verified. Before introducing any enrollment endpoint, establish an origin-level HTTPS response and configure a dedicated default-deny Access application; do not modify the existing AMPHETAMIN Access application.


## I0.9 — GROUP Access application created (2026-11-28)

The owner explicitly authorized creation of a dedicated Cloudflare Access application for the GROUP `workers.dev` hostname with default-deny. Cloudflare account API `POST /accounts/{account_id}/access/apps` created the following self-hosted application:

- Name: `SYMBIOTYC GROUP Control Plane`
- Application ID: `2db93e50-e75b-4674-b55e-47631a2b7acf`
- Protected hostname: `symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev`
- Type: `self_hosted`
- Session duration: `1h`
- Access policies: **none** (`policies: []` on create response and independent GET read-back)
- App Launcher visibility: disabled
- OAuth/DCR: not configured
- Service Tokens: none created

Cloudflare's Access policy model is default-deny: with no Allow policy attached, the application grants no access. The app list was re-read after creation and contains exactly the dedicated GROUP app plus the pre-existing AMPHETAMIN app. The AMPHETAMIN app ID `eef48749-8655-44cf-b807-84b755fbfe22`, its owner-email Allow policy, and its OAuth/DCR configuration were unchanged.

This closes the unauthenticated Access path at the hostname layer; it does **not** implement Provisioner authentication, Worker credentials, enrollment, or heartbeat. No Service Token, signing secret, Worker binding, route, or application code was created or changed. I0 remains BLOCKED; registration/heartbeat routes remain absent and Scheduler/dispatch remain disabled. Origin-level end-to-end denial has not yet been independently probed from an external client.
