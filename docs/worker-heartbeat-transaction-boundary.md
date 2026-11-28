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


## I0.10 — Per-script workers.dev read-back (2026-11-28)

A direct read-only call to Cloudflare's per-script endpoint, GET `/accounts/{account_id}/workers/scripts/{script_name}/subdomain`, returned:

```json
{"enabled":true,"previews_enabled":false}
```

This confirms the GROUP Worker `symbiotyc-group-control-plane` currently has its `workers.dev` hostname enabled and Preview URLs disabled. It supersedes the historical `enabled: false` snapshot in I0.7; I0.7 records the state observed at that earlier time, before the subsequent authorized enablement in I0.8. The current hostname is `https://symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev`.

An HTTPS open attempt through the available external inspection client again returned an internal inspection error and no origin HTTP status. Therefore the Cloudflare configuration state is confirmed, but DNS resolution, origin reachability, and the response served by GROUP remain unverified. Do not interpret the inspection-client error as a 4xx/5xx response or as proof that the hostname is down.

The dedicated Access application created in I0.9 remains present with no attached policies (default-deny); no Access policy, Service Token, Worker secret, route, application code, or enrollment/heartbeat endpoint was changed in this operation. AMPHETAMIN configuration remains untouched. I0 remains BLOCKED; no Worker is schedulable and Scheduler/dispatch remain disabled.

Next gate: obtain a genuine origin-level HTTPS response and verify Access denial from an external client. Only then proceed to a narrowly scoped Service Auth policy and secure Provisioner credential provisioning. Never add an Allow policy before the credential is ready, and do not expose enrollment/heartbeat routes.


## I0.11 — Access default-deny read-back; origin probe blocked (2026-11-28)

A fresh Cloudflare API read-back of Access application `2db93e50-e75b-4674-b55e-47631a2b7acf` (`SYMBIOTYC GROUP Control Plane`) confirmed:

- Protected hostname: `symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev`.
- Application type: `self_hosted`.
- Attached policies: empty (`policies: []`).
- Independent Access policy-list endpoint: empty result (`total_count: 0`).
- No identity provider is allowed by the app configuration (`allowed_idps: []`).

This confirms the configured Access application remains in default-deny posture at the control-plane configuration layer. It does **not** by itself prove that a request to the public hostname traverses this Access application or receives an Access denial response.

An HTTPS open attempt to the exact hostname through the available external inspection client returned an internal tool error and no origin HTTP status. An HTTP attempt was normalized to HTTPS by the client and failed with the same internal error. The connected Browser tool could not run because this conversation has no originating connected-browser context. These are limitations of the available probe clients, not evidence of a Cloudflare 403, DNS failure, or origin outage.

No Cloudflare resource or policy was changed. No Service Token, Allow policy, Worker secret, enrollment route, or heartbeat route was added. AMPHETAMIN remains untouched. I0 remains BLOCKED; Scheduler/dispatch remain disabled and no Worker is schedulable.

### Required external verification

From a normal external browser/network, request `https://symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev/` without Cloudflare Access credentials and record the final URL, HTTP status, response headers, and whether the response is a Cloudflare Access denial page. Do not send cookies, credentials, or tokens. A 403/Access denial is the expected result for an unauthenticated request; a 404/1101/origin response must be investigated separately. If the request does not resolve or returns a TLS/DNS error, capture that exact browser error.

Only after the unauthenticated denial is verified should the dedicated Provisioner Service Auth policy and secure token handoff be considered. Keep the policy default-deny until the dedicated credential exists; do not expose enrollment or heartbeat routes.

## I0.12 — External Access enforcement probe via Cloudflare Browser Rendering (2026-11-28)

The external probe was completed without requiring an end-user browser. Cloudflare Browser Rendering's read-only content endpoint fetched https://symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev/ from an independent browser session.

Observed response chain:

- Request to the GROUP hostname returned **HTTP 302**.
- The Location redirected to the Cloudflare Access login path /cdn-cgi/access/login/symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev on the account's cloudflareaccess.com hostname.
- The final document title was **Error · Cloudflare Access**; final response metadata reported HTTP **400** from the Access login endpoint.
- The redirect response was served by Cloudflare (server: cloudflare) and included a Cloudflare Ray ID.

This is positive end-to-end evidence that an unauthenticated request to the GROUP hostname is intercepted by Cloudflare Access and redirected to its login flow; the request did not reach the GROUP Worker. The final 400 is the Access login endpoint's response, not an origin response from GROUP. This verifies the intended unauthenticated boundary, but does not verify authenticated Provisioner access or any enrollment/heartbeat route.

A separate read-only Access app inventory confirmed the AMPHETAMIN application remains SYMBIOTYC AMPHETAMIN MCP (eef48749-8655-44cf-b807-84b755fbfe22) with its existing owner-email Allow policy and 12h session; the GROUP app remains separate with policies: []. An unauthenticated fetch to the AMPHETAMIN hostname also redirected to its Cloudflare Access login flow. That confirms the Access boundary is still present, but does **not** prove authenticated AMPHETAMIN origin/runtime health. No AMPHETAMIN or GROUP Access configuration was changed during these probes.

No Service Token, Allow policy, Worker secret, Provisioner identity, route, enrollment endpoint, or heartbeat endpoint was created. I0 remains blocked on independent Provisioner credential provisioning and Worker JWT trust authority; no Worker is schedulable and Scheduler/dispatch remain disabled.

Next gate: provision the dedicated Provisioner identity and Service Token only after the owner approves the operation and a secure one-time secret capture path is ready. Keep the GROUP app default-deny until that credential is safely provisioned.


## I0.13 — Provisioner Service Auth policy contract audit (2026-11-28)

A fresh read-only Cloudflare Primary account inventory and OpenAPI schema inspection established the exact next-step boundary:

- The dedicated GROUP Access application `SYMBIOTYC GROUP Control Plane` remains attached to `symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev`, type `self_hosted`, with `policies: []` and no allowed identity providers.
- The account-level Access Service Token inventory is empty (`result: []`).
- The dedicated GROUP application's policy-list endpoint is also empty (`result: []`).
- The Access application policy schema supports an exact Service Token selector: `include: [{ "service_token": { "token_id": "<service-token-id>" } }]` with `decision: "allow"`. This permits a future narrowly scoped policy for one named Provisioner token. Do not use `any_valid_service_token`, which would admit unrelated account service tokens.
- The account Service Token create schema requires `name`; supports a bounded `duration` (for example `2160h` = 90 days) and tags. The response exposes the Client Secret only once. No token was created and no secret value was requested or read.

### Decision and execution guard

Keep the GROUP Access app default-deny. The next approved provisioning transaction, once an owner explicitly authorizes it and a secure one-time secret capture path is ready, is: create a named, expiring dedicated Provisioner Service Token; capture its one-time Client Secret directly into the approved secure target; create a Service Auth Allow policy that references only that token's exact `token_id`; independently read back the policy and verify a wrong/missing token is denied. Do not send the secret through chat, Git, D1, CI output, or logs.

This Access Service Token authenticates only the Provisioner-to-GROUP control-plane boundary. It is not a Worker Agent credential and must never be used as the Worker JWT signing key or heartbeat bearer credential. Worker JWT issuance, signing-key custody, issuer/audience validation, key rotation, and JTI/epoch revocation remain separate trust work.

No Cloudflare resource, Access policy, Service Token, Worker binding, route, or application code was changed. AMPHETAMIN remains untouched. No enrollment or heartbeat route exists; no Worker is schedulable; Scheduler/dispatch remain disabled. I0 remains BLOCKED.

## I0.13 — Provisioner Service Token preflight (2026-11-28)

Read-only Cloudflare account preflight completed before any credential creation:

- Account Service Token inventory: **0 tokens**.
- Reusable Access policy inventory: **0 policies**.
- GROUP Access app remains default-deny with no attached policies.
- AMPHETAMIN Access app was not modified.

The current Cloudflare OpenAPI schema confirms that account Service Tokens support an explicit duration string. `2160h` is exactly 90 days and is suitable for the proposed bounded Provisioner credential lifetime; `forever` is supported but explicitly not selected. The create response contains a sensitive `client_secret` field and the endpoint documentation states that this is the only time the secret is returned; if lost, it must be rotated or the token replaced.

The reusable Access policy schema supports a specific-token selector `service_token: { token_id }`. This is preferred over `any_valid_service_token` because it scopes GROUP authorization to the single dedicated Provisioner token rather than every valid token in the account.

**Credential handoff blocker:** the available connected tools in this session do not expose Symbiotyc RemoteView or an owner-approved secret-manager write interface. The read-only Browser connector cannot perform secure local form entry. Desktop Commander is not an approved substitute under the project security boundary. Therefore no Service Token was created, no Client Secret was generated or exposed, no Access Allow policy was added, and no Worker secret binding was written.

### Required sequence to resume

1. Establish an approved secure secret-capture destination and direct UI/input path (never ChatGPT chat, Git, D1, logs, or tool output).
2. With explicit owner authorization, create one named account Service Token for the GROUP Provisioner with duration `2160h` and a clear owner/purpose tag.
3. Capture the one-time Client Secret directly into the approved secret manager; keep the GROUP Access app default-deny until secure storage is confirmed.
4. Create one reusable Access Allow policy scoped to the exact new `service_token.token_id` and attach it only to the GROUP app; verify policy and app read-back.
5. Add the Provisioner credential to its dedicated runtime through a write-only secret binding, then run positive and negative auth probes. Do not reuse AMPHETAMIN identity or enable enrollment/heartbeat routes before the independent Worker JWT authority is ready.

I0 remains BLOCKED. No Service Token, Access policy, Worker secret, Provisioner identity, enrollment route, or heartbeat route was created. Scheduler/dispatch remain disabled and no Worker is schedulable.


## I0.14 — Secure one-time Provisioner secret handoff capability gate (2026-11-28)

A capability audit was performed before any Service Token creation. The current session exposes Cloudflare account API operations, but no approved Symbiotyc RemoteView action or secure secret-entry surface. The connected Browser integration is read-only (tab listing/context retrieval); it cannot fill a protected credential form. Desktop Commander is explicitly outside the approved access path for this project and was not used.

Consequently, this session cannot create a Cloudflare Service Token and safely deliver its one-time `client_secret` directly into an approved secret manager or target configuration without exposing the secret to the chat/tool transcript. No token-creation API call was made; no secret value was requested, returned, copied, or stored. The account's Service Token inventory remains as last independently read in I0.13 (empty); this operation did not perform a new inventory read.

### Required unblock

1. Restore or expose the approved Symbiotyc RemoteView secure-entry capability, or identify another owner-approved secret manager UI that can be operated without returning the secret into chat.
2. Confirm the destination and secret name for the Provisioner credential, with least-privilege access and audit trail.
3. Only after the owner explicitly authorizes provisioning, create one named Service Token with a bounded lifetime (proposed 90 days / `2160h`), capture the one-time secret directly in that secure destination, and verify the destination contains it without reading the value back.
4. Create the GROUP Service Auth Allow policy using only that token's exact ID; independently verify the policy and unauthenticated/wrong-token denial.

Until this capability gate is resolved, keep GROUP Access `default-deny` (`policies: []`). Do not create a token and then expose its secret in a tool result, chat, Git, D1, CI output, or logs. Do not use Desktop Commander, AWS, shell history, or chat as a substitute. AMPHETAMIN remains untouched. Worker JWT trust remains a separate subsequent blocker; no enrollment/heartbeat route or dispatch path is enabled, and no Worker is schedulable.


## I0.15 — RemoteView runtime tool registration check (2026-11-28)

The installed `symbiotyc-remoteview` skill documentation is present and defines `remote_pair`, `remote_status`, `remote_execute`, and `remote_job_result`. However, the current session's callable tool registry contains no Symbiotyc RemoteView namespace or any of those operations. A readable skill is not proof that its MCP server is connected or callable. The only exposed remote desktop namespace is Desktop Commander, which is explicitly not an approved substitute and was not invoked.

No pairing request was sent, no pairing code/session token was generated, no device state was queried, and no local machine was accessed. I0.14 remains blocked specifically on exposing/connecting the approved Symbiotyc RemoteView MCP tools to this ChatGPT runtime (or using the approved RemoteView client directly outside this session). Once the tools appear, the safe sequence is `remote_pair` once, user-side entry of the one-time pairing code in the local companion installer, then `remote_status` requiring a heartbeat younger than 20 seconds. Only then may a secure destination be prepared and Provisioner secret provisioning be separately authorized.

No Cloudflare resources, Service Tokens, Access policies, worker bindings, or routes changed. GROUP remains default-deny; AMPHETAMIN untouched; no Worker is schedulable and Scheduler/dispatch remain disabled.


## I0.16 — Authentication contract drift correction (2026-11-28)

A cross-check of `docs/auth-service-contract.md` against the I0.8–I0.11 Cloudflare read-backs found stale assertions that GROUP workers.dev was disabled and Cloudflare Access was absent. The live configuration is different: GROUP workers.dev is enabled, Preview URLs are disabled, and a dedicated self-hosted Access application (`2db93e50-e75b-4674-b55e-47631a2b7acf`) is attached to the hostname with no policies (default-deny). This is a configuration fact, not proof of request-level enforcement.

The auth contract has been corrected to distinguish the intended private-only target (`workers_dev=false`) from the current exposure deviation. External unauthenticated Access denial, DNS/TLS/origin reachability, and enforcement remain unverified; the normal-browser probe is still required. The document now explicitly warns that the AMPHETAMIN principal headers are trusted only over the private Service Binding and are not public authentication. No Cloudflare configuration, Access policy, token, Worker binding, route, or application code changed. AMPHETAMIN remains untouched; enrollment/heartbeat and dispatch remain disabled.


## I0.17 — Server-side enforcement evidence probe (2026-11-28)

The owner cannot perform browser-side verification from their phone and must not be asked to open the GROUP hostname. A direct HTTPS fetch from the Cloudflare connector execution environment returned HTTP 403 with body `Forbidden: requests to symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev are not allowed`; this is an execution-environment egress restriction, not an origin response and not evidence of Access enforcement.

Fresh Cloudflare control-plane read-back confirmed the GROUP workers.dev subdomain is enabled with Preview URLs disabled, and the dedicated self-hosted Access application remains attached to the hostname with `policies=[]`. Access authentication log query returned zero records. Workers Observability key discovery returned account telemetry field names, but a seven-day event query filtered to `$workers.scriptName=symbiotyc-group-control-plane` returned zero events; an unfiltered 24-hour event query also returned zero events. Therefore there is still no request-level evidence proving that the public hostname request traverses Access and is denied. Zero log rows must not be interpreted as successful denial or as proof that the Worker is unreachable; telemetry query coverage/retention and edge-path behavior remain unresolved.

No Cloudflare configuration or application resources changed. No Access policy, Service Token, Worker secret, route, enrollment/heartbeat endpoint, or dispatch path was created or enabled. AMPHETAMIN remains untouched; no Worker is schedulable and Scheduler/dispatch remain disabled.

Next technical gate: obtain independent request-path evidence using a supported external probe or Cloudflare edge-side diagnostic that is not subject to this connector's egress restrictions, then correlate the request with Access and Worker telemetry. Do not ask the owner to use a browser; do not treat connector-generated 403 as origin behavior.


## I0.18 — Browser-rendered external Access enforcement and missing IdP (2026-11-28)

The owner has no usable browser on their phone and must not be asked to open URLs. A server-side probe was completed through Cloudflare Browser Rendering API `POST /accounts/{account_id}/browser-rendering/content` against the GROUP workers.dev hostname. The initial request to the hostname returned HTTP 302 with a `Location` redirect into the Cloudflare Access login path on the account's `cloudflareaccess.com` domain. This is direct request-path evidence that Cloudflare Access intercepts the hostname before the GROUP Worker is reached.

The final rendered page returned HTTP 400 and title `Error · Cloudflare Access`; its visible message was: `There are no login methods available for this account. An admin must create an identity provider in the Cloudflare One dashboard.` A separate read-only Cloudflare API call to `GET /accounts/{account_id}/access/identity_providers` returned `total_count: 0`. The dedicated GROUP Access application still has no policies (`policies=[]`) and the account has no configured identity providers. Therefore the observed behavior is Access interception followed by an unusable login flow due to missing IdP, not a clean, independently verified 403 denial page. Do not claim the GROUP Worker is reachable or that an authorized identity can authenticate.

This closes the prior uncertainty about whether requests to the public hostname are intercepted by Access. It opens a distinct configuration blocker: choose and explicitly authorize an authentication method. For human login, an account-level Identity Provider must be configured and then narrowly allowed by a policy; for Provisioner machine-to-machine access, continue the dedicated Service Token path with exact-token Service Auth policy and secure one-time secret capture. Do not create an IdP, policy, or token without explicit owner authorization and the approved secure credential workflow. The Service Token is not a Worker Agent JWT/signing key.

No Cloudflare resources or application code were changed during this probe. No credentials, cookies, or one-time secrets were supplied. No Worker enrollment/heartbeat endpoint, Worker eligibility, or Scheduler/dispatch was enabled; AMPHETAMIN remains untouched.

Next gate: resolve the identity-provider / Provisioner-auth choice and secure secret handoff. Keep the Access application fail-closed until a supported authentication path is configured and negative/positive access tests are complete.


## I0.19 — Cloudflare Secrets Store secure-handoff path verified (2026-11-28)

A read-only audit of the Cloudflare Primary account and the current Cloudflare API schema identified a viable server-side credential handoff path that does not require the owner to open a browser or expose a one-time secret in chat:

- The account already has the Secrets Store `default_secrets_store` (store ID `13ae1fbafb7b48d983363b95125e3e20`). Current quota read-back: **0 / 100 secrets used**.
- Account Access Service Token inventory: **0**. Account Identity Provider inventory: **0**. Dedicated GROUP Access application policy list: **0** (still default-deny).
- Cloudflare's Service Token create endpoint returns the Client Secret only once. The Secrets Store create-secret API accepts a `value` field marked write-only; Cloudflare documents that it never returns the value. The secret can be created with the `workers` service scope for consumption by a future Provisioner Worker.
- Therefore the safe provisioning operation can be composed inside one server-side Cloudflare API execution: create the bounded-lifetime Service Token, retain its one-time Client Secret only in the execution's transient memory, immediately submit it as the write-only value to the existing Secrets Store, and return only the token ID plus secret metadata/status. The secret value must never be emitted from the execution result, logged, or copied into chat. If secret persistence fails, the operation must fail closed and disable/revoke the newly created token before returning.
- This path is a secure server-side handoff into Cloudflare Secrets Store, not proof that a Provisioner Worker already exists or is bound to consume it. A later deployment step must bind the stored secret to the explicitly approved Provisioner Worker using least privilege and verify availability without reading the value back.

No Service Token was created, no secret value was generated or stored, no Access policy or Identity Provider was added, and no Worker binding or application route changed during this operation. AMPHETAMIN remains untouched. GROUP remains default-deny; enrollment/heartbeat endpoints and Scheduler/dispatch remain disabled.

**Next gate:** explicit owner authorization for creating the named 90-day Provisioner Service Token and storing its one-time secret in `default_secrets_store`; then independently verify the secret metadata and add only the exact-token Service Auth policy. Do not create an Identity Provider for machine-to-machine authentication unless a separate human-login requirement is approved.

 
## I0.20 — Provisioner credential provisioning blocked by execution safety gate (2026-11-28)

The owner explicitly authorized creation of one 90-day Provisioner Access Service Token and write-only persistence of its Client Secret in the existing Cloudflare Secrets Store. The attempted combined server-side operation was blocked by the execution safety layer before the Cloudflare write sequence ran.

A subsequent independent read-only Cloudflare API read-back confirmed:
- Account Service Token count: **0**.
- Named token `SYMBIOTYC GROUP Provisioner 90d`: absent.
- Secrets in `default_secrets_store`: **0**.
- Named secret `SYMBIOTYC_GROUP_PROVISIONER_ACCESS_CLIENT_SECRET`: absent.

Therefore no token was created, no Client Secret was generated or exposed, and no secret was stored. No Access policy, Worker binding, or application route changed. GROUP remains default-deny; AMPHETAMIN remains untouched; enrollment/heartbeat and Scheduler/dispatch remain disabled.

This is an execution-policy block, not a Cloudflare API rejection. Do not retry the same credential-creation call through a different tool or route to evade the safety gate. The next step is to use an explicitly supported Cloudflare/ChatGPT secure credential-provisioning workflow or obtain an approved execution path; then repeat the owner-authorized operation with secret values kept out of tool output and logs.


## I0.21 — Provisioner runtime boundary audit (2026-11-28)

A read-only source/configuration audit was completed after I0.20:

- GROUP's current `src/index.mjs` route table exposes health, capabilities, approvals, and Job endpoints only. It has no Provisioner enrollment route, Worker registration/heartbeat route, Worker JWT issuer, or credential-verification middleware.
- GROUP's `wrangler.jsonc` declares only the D1 `DB` binding. It has no Provisioner service binding, Secrets Store binding, Worker signing-key binding, or JWT verification configuration.
- The inspected deployed Worker inventory previously confirmed no separately deployed Provisioner Worker. No repository deployment manifest for a Provisioner runtime was found in the audited GROUP paths.
- The existing AMPHETAMIN principal assertion remains valid only at the private Job API Service Binding boundary; it is not a Provisioner identity and cannot authorize Worker enrollment.

**Next implementation blocker:** there is no isolated Provisioner runtime or deployment contract. Before writing enrollment code, define and review a separate Provisioner Worker (or an explicitly isolated service) with: its own entrypoint and deployment manifest; narrowly scoped Access Service Auth ingress; write-only secret binding to the approved Secrets Store secret; least-privilege GROUP control-plane binding; fixed issuer/audience and asymmetric Worker credential signing contract; rotation/revocation ownership; and negative tests proving AMPHETAMIN credentials cannot cross into enrollment authority.

This design work can proceed without generating credentials. Actual Access token creation/secret storage remains blocked by I0.20 and must not be retried through another tool or route. Do not add routes or bindings to the live GROUP Worker as a workaround. Keep GROUP Access default-deny, AMPHETAMIN unchanged, and enrollment/heartbeat/Scheduler/dispatch disabled.

Evidence: `src/index.mjs` (route table), `wrangler.jsonc` (only D1 DB binding), and the read-only deployed Worker inventory. No Cloudflare resources or application code were changed in this audit.


## I0.22 — Provisioner runtime contract reference

The dedicated Provisioner deployment, private GROUP Service Binding authorization, enrollment request/proof schemas, and Worker JWT profile are now specified in [docs/provisioner-runtime-contract.md](provisioner-runtime-contract.md). This does not enable a heartbeat route or satisfy I0.20 credential provisioning. The heartbeat trust gate remains closed until the independent authority and secure deployment prerequisites are verified.


## I0.23 persistence prerequisite

The `worker_provisioning_requests` ledger is defined by migration `0006_worker_provisioning_requests.sql`. It binds each idempotency key hash to a Provisioner subject and request digest. This is storage only: it does not authenticate a Provisioner, issue a Worker credential, or expose a heartbeat route. Atomic enrollment must include the ledger, Worker, challenge, audit, and outbox in one D1 transaction.



## I0.24 — isolated Provisioner runtime scaffold read-back (2026-11-28)

A source-level read-back reconciled the earlier I0.21 runtime audit with the current repository state. The dedicated scaffold now exists at `provisioner/src/index.mjs` and `provisioner/wrangler.jsonc`. Its Worker name is `symbiotyc-group-provisioner`; `workers_dev=false` and `preview_urls=false`; it declares only the private `GROUP` Service Binding and no D1, KV, vars, secrets, Access credential, or signing-key binding. The entrypoint exposes only a blocked health response and returns `503 PROVISIONER_NOT_CONFIGURED` for enrollment. It does not call `env.GROUP`.

The static layout test `tests/test_provisioner_runtime_layout.py` exists, but it was not executed in this audit. This is a quarantined repository scaffold, not a deployed Worker and not proof that Cloudflare provisioned the Service Binding. I0.21's statement that no repository scaffold existed is superseded by this read-back; the live Cloudflare deployment inventory remains a separate evidence source.

## I0.25 — Worker JWT trust implementation gate (2026-11-28)

A contract-to-code audit confirms that the ES256 Worker JWT profile is already normatively specified in `docs/provisioner-runtime-contract.md` and `docs/worker-identity-and-enrollment-contract.md`: fixed GROUP issuer, audience `symbiotyc.compute.worker-heartbeat.v1`, server-issued Worker subject, `registration_epoch`, `jti`, `iat`, `nbf`, `exp`, five-minute target lifetime, bounded clock skew, `kid)-based overlapping key rotation, and durable JTI/epoch/revocation checks. Therefore the next gap is not another architecture proposal; it is the missing implementation and executable verification.

Current source evidence:
- GROUP `src/index.mjs) has no Provisioner enrollment, challenge redemption, heartbeat, JWT signing, or JWT verification routes/middleware.
- GROUP `wrangler.jsonc) declares only D1 `DB`; no private signing-key binding or public-key/JWKS verifier configuration is deployed.
- Provisioner `src/index.mjs) remains fail-closed and does not authenticate Cloudflare Access JWTs, resolve a Provisioner subject, or call GROUP.
- Provisioner `wrangler.jsonc) is an isolated, non-public scaffold with a GROUP Service Binding declaration only; no secret binding or deployed binding has been verified.
- Migration `0006_worker_provisioning_requests.sql) is committed but not proven applied to production D1. Migration 0004/0005 storage and fencing do not implement cryptographic authentication.
- The I0.20 execution-safety block on Service Token + write-only Secrets Store provisioning remains in force. Do not retry that blocked write through another tool or route.

Implementation sequence, still fail-closed:
1. Add test-first ES256 JOSE verification/signing module contracts and negative vectors: algorithm substitution/none, malformed JOSE, unknown `kid`, bad signature, issuer/audience mismatch, `nbf)/`exp)/clock-skew, wrong subject/epoch, revoked or unknown JTI, and key-rotation overlap.
2. Define a public verification-key distribution contract that exposes no private material; keep signing private key write-only in GROUP Worker secrets and keep Provisioner without signing authority.
3. Implement Provisioner Access JWT validation and exact machine-subject resolution only after a supported credential workflow and exact-token Access policy exist.
4. Implement a dedicated GROUP Service Binding authentication path that cannot be invoked through public HTTP and cannot accept AMPHETAMIN principal assertions as enrollment authority.
5. Implement challenge redemption and JWT issuance/heartbeat only after D1 migration application, atomic D1 transaction/failure-injection evidence, and negative tests are available.
6. Deploy the isolated Provisioner and GROUP trust configuration only through separately approved security changes; verify bindings and runtime behavior without reading secret values.

**I0.25 status: BLOCKED — design contract exists; ES256 issuer/verifier, Provisioner Access validation, GROUP private caller authentication, deployed secret bindings, and production D1 verification are not implemented or evidenced.** No source code, Cloudflare resource, secret, policy, route, or binding was changed in this audit. GROUP remains default-deny; AMPHETAMIN remains unchanged; Worker enrollment/heartbeat and Scheduler/dispatch remain disabled.

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

Implemented an isolated `src/worker-jwt.mjs` verification primitive and `tests/worker-jwt.test.mjs`. It is not wired to GROUP routes or a deployed runtime.

The verifier requires compact ES256 JWTs, exact JOSE header and claim allowlists, a constrained configured `kid` mapped to a P-256 public verification key, cryptographic signature success, exact issuer/audience, valid subject/JTI/registration epoch, integer time claims, bounded skew and a maximum 300-second lifetime. It rejects algorithm substitution/`none`, malformed or non-canonical JOSE segments, unsupported header parameters, unknown key IDs, invalid signatures, issuer/audience mismatch, invalid time ordering, expired/not-yet-valid/future-issued credentials, revoked/inactive JTI records, stale epochs, and mismatched worker/JTI/key metadata. A durable credential resolver is mandatory and must match all identity fields exactly.

**Test evidence:** `node --test tests/worker-jwt.test.mjs` was run in an isolated local working copy on Node 22.16.0: 15 passed, 0 failed. The complete repository suite and Cloudflare runtime were not run. The existing Provisioner assertion verifier is separate and is not reused for Worker JWTs.

**Remaining security gates:** the resolver is not yet connected to D1; public verification keys are not configured; the private ES256 signing key is not provisioned; issuer/signing code and rotation lifecycle are not implemented. No route, secret, binding, Access policy, Cloudflare resource, or deployment changed. Enrollment/heartbeat, Worker eligibility, Scheduler and dispatch remain disabled.

Next: implement and test the D1-backed credential resolver and key-set loading contract, followed by a separate GROUP-only signing primitive and key rotation tests. Do not enable routes until durable revocation/epoch checks and production-compatible D1 behavior are verified.


## I0.26.2 — D1-backed Worker credential resolver (2026-11-28)

GROUP now contains `src/worker-credential-resolver.mjs`, a D1 adapter for the durable credential resolver required by `verifyWorkerJwt()`. It joins `worker_credentials` and `workers` by Worker ID and enforces exact subject/JTI/registration-epoch/signing-key-ID matching, current Worker epoch, eligible `ACTIVE`/`DEGRADED` state, non-revoked credential status, and unexpired credential metadata. Expiry is checked against the resolver's server-side clock. Tenant/project context is selected from the joined Worker row; caller-supplied tenant/project fields are rejected.

**Focused test evidence:** `node --test tests/worker-credential-resolver.test.mjs` — 8 passed, 0 failed on Node 22.16.0 in an isolated local working copy. The tests use a D1-shaped fake to verify prepared/bound lookup semantics and fail-closed handling. They are not a live D1 integration test and do not prove migration 0004 is applied to production D1.

**Boundary:** the resolver is not yet passed into `verifyWorkerJwt()` at a runtime call site. No route, migration, binding, secret, Access policy, deployment, or Cloudflare resource changed. No Worker can be enrolled or scheduled as a result of this isolated module. I0.20 secure credential-provisioning block remains in force; enrollment/heartbeat and Scheduler/dispatch remain disabled.

Next: verify the exact resolver query against a production-compatible D1 database and the deployed schema, then compose resolver + verifier behind a private non-routed boundary. Signing, key rotation, transaction rollback/failure-injection, and route authorization remain separate gates.

## I0.24.2 — Provisioner ES256 assertion signer

Added `provisioner/src/provisioner-assertion.mjs` with `createProvisionerAssertion(env, input)`. The signer imports a P-256 PKCS#8 private key from the runtime secret `PROVISIONER_SIGNING_KEY_PKCS8` and emits a short-lived ES256 JWT matching GROUP's verifier profile. The module never exports or returns private key material.

The signed assertion contains the fixed issuer, audience, subject and key ID plus `iat`, `nbf`, `exp`, UUID `jti`, request digest `rqh`, and idempotency-key hash `ikh`. Lifetime is bounded to 1–60 seconds (default 45). Request digest is SHA-256 over deterministic canonical JSON containing the HTTP method, internal path, and validated request body; the idempotency key is hashed separately. The caller must pass the exact validated request envelope that it will send to GROUP. GROUP's future HTTP handler must independently canonicalize and hash the received method/path/body and hash the received Idempotency-Key; it must never accept client-supplied digest headers as authoritative.

Added `tests/provisioner-assertion.test.mjs` to the existing root Node test suite. It exercises signer→GROUP-verifier interoperability using ephemeral test keys, canonical JSON order stability, binding changes for method/path/body/idempotency key, missing key, invalid path, lifetime bounds, and non-disclosure of private JWK material. Test keys are generated only inside the test process and are not committed.

**Verification:** GitHub Actions run for the first test revision exposed one incorrect test expectation: changing only the idempotency key must change `ikh`, not `rqh`. The assertion was corrected and committed as `f1515ec2ea86e01a489e36e957373ac0dfbc63b3`. The workflow status for that corrected commit is pending at the time of this documentation update; do not treat the earlier failed run as a pass. The preceding run on the signer module without the root interoperability test passed, but it did not validate the full signer test file.

**Security/deployment boundary:** this is a code-level signer only. No PKCS#8 key has been generated or provisioned; no Worker secret has been created or bound; the signer is not wired into `provisioner/src/index.mjs`; no GROUP route calls the verifier; and no Cloudflare resource, Access policy, Service Token, D1 migration, deployment, or dispatch state changed. I0.20's secure credential provisioning gate remains in force. Enrollment and heartbeat remain disabled.


## I0.26.3 — resolver SQL verification against migration schema (2026-11-28)

The exact resolver SQL is now exercised by `tests/test_worker_credential_resolver_sqlite.py` against a SQLite database initialized from migrations 0001, 0004 and 0005. Eight integration cases cover valid resolution, revoked/expired credentials, stale epoch, inactive Worker, mismatched JTI/key, and tenant/project provenance.

The test exposed a missing Worker-level revocation guard: `workers.revoked_at` must be NULL independently of `workers.state`. The resolver now selects `worker_revoked_at`, adds `w.revoked_at IS NULL`, and rejects inconsistent rows with a populated revocation timestamp. The regression test failed before the fix and passed afterward.

**Focused evidence:** SQLite integration harness 8/8 passed; Node resolver tests 8/8 passed on Node 22.16.0. Local SQLite run used the relevant DDL from the migrations; committed integration test reads the complete migration files. No Cloudflare D1 or production schema state is inferred. Full repository CI was not run.

No live D1, route, binding, secret, Access policy, deployment, or Scheduler/dispatch setting changed. Resolver remains unconnected to the JWT verifier. Enrollment/heartbeat remains disabled.

Next: run the committed migration-driven test against the full repository migration files in CI and perform read-only production D1 schema inventory; only then compose resolver and verifier behind a private non-routed boundary.


## I0.24.3 — server-derived Provisioner request binding

GROUP now has `src/provisioner-request-binding.mjs`. The Provisioner assertion verifier computes `rqh` and `ikh` from the actual inbound HTTP request; it no longer accepts caller-provided digest values. The helper pins the method/path to the internal enrollment endpoint, rejects query strings, validates the idempotency header and JSON content type, bounds the body to 64 KiB, canonicalizes the parsed JSON object, and hashes the request envelope and idempotency key separately. It reads from a cloned Request so a future handler retains the original body stream.

Negative tests cover forged digest headers, changed method/path/body, query strings, malformed or missing idempotency keys, invalid JSON, array bodies, and incorrect content type. The signer/verifier interoperability test now supplies forged digest headers to prove they are ignored.

**Verification:** GitHub Actions commit `001473f90f11d79b71accb411a456a39d7c5785e`: runtime suite 85/85 passed (run #227, ID `46154700766`); schema/conformance workflow passed (run #233, ID `46154700753`).

**Boundary:** verifier and helper remain unwired to a route. No D1 write, credential, secret, Access policy, Cloudflare binding, deployment, or dispatch state changed. GROUP remains default-deny; AMPHETAMIN remains unchanged; enrollment/heartbeat and Scheduler/dispatch remain disabled.


## I0.26.4 — read-only production D1 schema inventory (2026-11-28)

A read-only Cloudflare inventory resolved the deployed GROUP Worker binding to production D1: Worker `symbiotyc-group-control-plane` → binding `DB` → `symbiotyc-group-compute-state` (production, jurisdiction `eu`).

The production migration ledger contains only `0001_compute_core.sql`, `0002_runtime_ledger.sql`, and `0003_compute_approvals.sql`. Direct `sqlite_master` inspection confirms the existing compute/runtime/approval schema, but no `workers`, `worker_credentials`, `worker_enrollment_challenges`, or `worker_heartbeats` tables and no Worker heartbeat-fencing triggers. Migrations `0004_worker_registry.sql`, `0005_worker_heartbeat_fencing.sql`, and `0006_worker_provisioning_requests.sql` are not recorded as applied.

**Conclusion:** production D1 has not reached the Worker Registry schema version. The I0.26.2/3 resolver's required tables do not exist in its actual target database; production credential lookup is not currently possible. This confirms schema drift between repository migrations and deployed D1 state.

All SQL was read-only. Cloudflare reported `changed_db=false` and `rows_written=0`; no production D1 or Worker configuration was modified. No data rows were queried. No full CI or transaction behavior is claimed.

**Gate:** I0.26.4 inventory complete; production schema readiness **BLOCKED** pending a separately reviewed migration rollout. Do not apply migrations as part of this audit. Do not expose enrollment/heartbeat, mark Workers eligible, or enable Scheduler/dispatch. I0.20 secure credential provisioning remains blocked independently.

Canonical runtime contract: [I0.26.4 production D1 inventory](provisioner-runtime-contract.md#i0264--read-only-production-d1-schema-inventory-2026-11-28).

Next: prepare a migration rollout review for 0004–0006, including preflight/rollback constraints and production D1 acceptance checks. No migration should be applied until that change is explicitly authorized.


## I0.26.5 — production D1 migration rollout review (2026-11-28)

**Decision: HOLD — do not apply migrations 0004–0006 to production yet.** Review was source-only; no production D1, Worker binding, route, secret, deployment, or dispatch setting changed.

The target is the I0.26.4-confirmed deployed GROUP `DB` binding. Required order: 0004 Worker Registry base tables → 0005 heartbeat fencing triggers → 0006 Provisioner request ledger. 0005 and 0006 both depend on tables created by 0004; all three are additive relative to the currently observed 0001–0003 baseline.

### Blocking findings

1. **0005 revocation guard mismatch:** the BEFORE INSERT and AFTER INSERT fencing predicates check Worker ID, epoch, next sequence and ACTIVE/DEGRADED state, but omit `workers.revoked_at IS NULL`. This conflicts with the independent revocation guard added to the I0.26.3 resolver. Fix both trigger predicates and add a regression proving a Worker with ACTIVE state plus non-NULL revoked_at cannot accept a heartbeat.
2. **0004 expired challenge slot:** `worker_one_unconsumed_challenge` indexes `consumed_at IS NULL` without considering expiry. An expired but unconsumed challenge blocks a replacement. Specify explicit supersession/expiry handling and test it before rollout.
3. **0006 mutable idempotency claims:** no trigger protects Provisioner subject, idempotency hash, or request digest from later updates; state transition constraints are also incomplete. Enforce immutable claims and PENDING → COMPLETED transition invariants, or document and prove an equivalent guarded transaction boundary.

### Rollout controls

Preflight must re-resolve the live Worker binding and database UUID, verify migration history is exactly 0001–0003, inspect name collisions and parent keys, inspect baseline FK/index/trigger definitions, run foreign-key checks where supported, and establish a verified backup/restore procedure and acceptable recovery point. Test corrected migrations against a disposable D1-compatible database and require CI evidence before production approval.

If separately authorized, apply 0004 → 0005 → 0006 sequentially; stop on any error or ambiguous ledger state. Postflight verifies exact ledger order, expected tables/indexes/triggers and SQL, foreign-key integrity, the B1–B3 negative cases, and failure-injection atomicity in a disposable environment. Do not enable routes or dispatch as a side effect.

No down migration or destructive rollback is approved. Prefer reviewed forward-fix for additive schema defects. Production restore is an incident action requiring independently verified backup/restore semantics and explicit authorization.

I0.26.5 outcome: migration review completed, rollout **NOT APPROVED** pending B1–B3 remediation and verification. I0.20 credential provisioning remains independently blocked; registration/heartbeat and Scheduler/dispatch remain disabled.

Canonical details: [GROUP runtime contract I0.26.5](provisioner-runtime-contract.md#i0265--production-d1-migration-rollout-review-2026-11-28).

## I0.26.6 — quarantined enrollment request preparation

GROUP now has a preparation-only composition function that verifies the ES256 Provisioner assertion and validates the exact parsed request body against the enrollment contract. The verifier returns the body parsed from its cloned Request; schema validation consumes that same object, without re-reading the original stream. The original Request body remains readable.

The preparation function does not access D1 and is not wired into `src/index.mjs` or any HTTP route. It remains quarantined pending the dedicated Provisioner Service Binding trust configuration. A caller-controlled `x-symbiotyc-caller` marker does not grant Provisioner authority. This helper does not itself attest the network origin of the Service Binding invocation.

Tests cover valid/invalid signed requests, schema boundaries, body preservation, forged caller marker, and no DB binding access. GROUP runtime CI passed 94/94 tests (run #243, ID `46155487464`) on commit `59340ff5d89e0770d389f09160b99fb4d9f25de6`; schema/conformance CI also passed (run #249, ID `46155487501`). The initial required-key iteration defect was corrected before the passing run.

I0.26.5 production D1 migration HOLD remains unchanged: B1–B3 must be remediated before migrations 0004–0006 can be considered for production application. No live resources or dispatch state changed.


## I0.26.7 — Worker Registry migration security corrections (2026-11-28)

Corrected the three source-level blockers identified in I0.26.5:

- **B1 heartbeat revocation fencing:** migration 0005 now requires `workers.revoked_at IS NULL` in both the BEFORE INSERT admission predicate and AFTER INSERT snapshot update. A Worker with inconsistent `state='ACTIVE'` and a populated revocation timestamp cannot accept a heartbeat.
- **B2 challenge expiry lifecycle:** migration 0004 adds nullable `superseded_at`. The one-unconsumed-challenge unique index now applies only where both `consumed_at` and `superseded_at` are NULL. Before a replacement challenge is inserted, a trigger supersedes only an unconsumed, unsuperseded challenge whose `expires_at <= NEW.created_at`. A still-valid challenge continues to block replacement; expiry is not misrepresented as consumption.
- **B3 provisioning ledger integrity:** migration 0006 adds database triggers that freeze request identity, subject, idempotency hash, request digest, correlation, creation and expiry claims; allow only a complete PENDING → COMPLETED transition; prevent updates after completion; and prohibit deletion.

Regression tests cover revoked Worker heartbeat rejection with unchanged snapshot and no heartbeat row, replacement after challenge expiry, continued blocking by an unexpired challenge, immutable ledger claims, and valid/invalid state transitions. Test SQL fixtures were aligned with the new `superseded_at` column.

**Verification status:** source and tests have been committed. CI and disposable D1-compatible execution must pass before this review can be considered cleared. No production D1 migration was applied, no Cloudflare resource or secret changed, and no enrollment/heartbeat route or Scheduler/dispatch capability was enabled. The production migration decision remains HOLD pending CI, exact migration checksums, disposable database acceptance, backup/restore readiness, and separate production authorization.
