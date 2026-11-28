# AMPHETAMIN-to-GROUP Internal Service Binding Contract

**Status:** Intended internal Job API trust contract; current Cloudflare exposure differs from the target and is recorded below. No production AMPHETAMIN Worker or GROUP deployment behavior is inferred from this document alone.

## Current deployment security state (I0.8–I0.11)

The GROUP Worker is currently enabled on the account's workers.dev subdomain:

`https://symbiotyc-group-control-plane.vladyslavchaplygin.workers.dev`

Its per-script Cloudflare subdomain settings were independently read back as `enabled=true`, `previews_enabled=false`. Thus the earlier target statement that `workers_dev=false` is NOT the current state.

A dedicated Cloudflare Access self-hosted application protects this hostname:

- Application: `SYMBIOTYC GROUP Control Plane`
- Application ID: `2db93e50-e75b-4674-b55e-47631a2b7acf`
- Type: `self_hosted`
- Session duration: `1h`
- Access policies: none (`policies=[]`); the intended posture is default-deny.
- Service Tokens: none were present in the last inventory read (I0.13); no Provisioner token was created.
- Preview URLs are disabled at the Worker subdomain setting.

**Important evidence boundary:** the Access control-plane configuration is verified, but an unauthenticated external request has not yet produced a verified Access denial response. DNS/TLS/origin reachability and request-level Access enforcement remain unverified. Do not describe the hostname as externally proven blocked or the Worker as private-only until an external probe confirms it. The Access app's existence alone is not proof of enforcement.

## Intended trust model

AMPHETAMIN is the standalone MCP ingress and authenticates its external caller. GROUP is the Compute Control Plane. There is no shared `API_TOKEN`, bearer secret, or credential transfer between AMPHETAMIN and GROUP.

The intended Job API ingress is a Cloudflare Worker Service Binding configured on AMPHETAMIN:

```toml
[[services]]
binding = "GROUP"
service = "symbiotyc-group-control-plane"
```

The principal assertion below is trusted only on this private Service Binding boundary. It is not a cryptographic credential and MUST NOT be accepted merely because a request contains these headers over public HTTP. The current workers.dev hostname is an exposure deviation from the original private-only target; keep the Access application default-deny and verify enforcement before relying on it as an outer gate. Do not add public routes or expose Worker Registry endpoints.

## Request assertion

AMPHETAMIN calls GROUP through `env.GROUP.fetch(request)` and adds:

- `x-symbiotyc-caller: amphetamin`
- `x-symbiotyc-principal: <base64url(JSON principal)>`

The decoded principal has this shape:

```json
{
  "kind": "user",
  "tenant_id": "tenant-from-authenticated-session",
  "project_id": "authorized-project",
  "actor_id": "authenticated-subject",
  "scopes": ["compute:jobs:write", "compute:jobs:read", "compute:jobs:cancel"]
}
```

AMPHETAMIN must derive every principal field from its authenticated session and server-side tenant/project membership. It must not copy `tenant_id`, `project_id`, `actor_id`, role, or scope values from caller-supplied tool arguments.

GROUP validates the caller marker, bounded assertion size, principal shape, and endpoint scope. These checks are meaningful as an internal assertion only when the request is proven to have arrived through the Service Binding boundary. They do not independently authenticate a public caller.

## Security invariants

- The target production posture remains no public ingress: `workers_dev=false`, `preview_urls=false`, and no public route, deployment URL, or custom-domain route.
- Current deviation: workers.dev is enabled; the dedicated Access app is configured default-deny but external enforcement remains unverified.
- Only the AMPHETAMIN Worker should be configured with a Service Binding to GROUP.
- The AMPHETAMIN MCP endpoint independently authenticates external clients and authorizes project membership.
- Worker identity and Worker control remain exclusively inside GROUP; AMPHETAMIN cannot register, configure, or directly contact Workers.
- No static API_TOKEN is shared, copied, returned, or written to GitHub/Wiki.
- Service-binding and public-exposure configuration changes are reviewed as security-sensitive deployment changes.
- No Worker enrollment/heartbeat route is enabled by this contract; the Worker Registry trust gates remain separate.

## Deployment and verification gate

Before treating GROUP as private/internal in production:

1. Verify the exact external hostname from a normal unauthenticated browser/network and capture final URL, HTTP status, and whether the Cloudflare Access denial page appears. Do not share cookies or credentials.
2. Distinguish Access denial from DNS, TLS, or origin failure; only an actual Access denial confirms request-level enforcement.
3. Verify the Access application remains attached to the exact hostname and default-deny (`policies=[]`) until a dedicated Provisioner Service Token is securely provisioned and an exact-token policy is deliberately created.
4. Verify `preview_urls=false` and inspect Version/Preview/Deployment URLs separately; disabling workers.dev alone does not disable them.
5. Verify AMPHETAMIN is the sole Service Binding consumer and test missing/wrong caller marker, malformed principal, and missing scopes fail closed.
6. Prefer restoring `workers_dev=false` once the approved internal Service Binding path is validated and public hostname access is no longer required.

Cloudflare Access is now configured for GROUP, contrary to the older statement in this document; enforcement at the external request layer is still unverified. External AMPHETAMIN authentication remains a separate prerequisite.


## I0.18 — Runtime Access probe (2026-11-28)

Cloudflare Browser Rendering was used for a server-side request to the GROUP hostname. The hostname returned HTTP 302 into the configured Cloudflare Access login path, proving request interception. The rendered Access page returned HTTP 400 with: `There are no login methods available for this account. An admin must create an identity provider in the Cloudflare One dashboard.` A read-only `GET /accounts/{account_id}/access/identity_providers` returned `total_count: 0`; the GROUP Access application still has `policies=[]`.

Interpretation: Access intercepts the hostname, but no Identity Provider or usable human login method is configured. The HTTP 400 is the Access login configuration error, not a GROUP origin response and not a clean 403 denial test. The prior external request-path uncertainty is closed; the next blocker is choosing and explicitly authorizing a human IdP + narrowly scoped policy or the separate Provisioner Service Token + exact-token Service Auth policy. The latter still requires approved secure one-time secret capture. No Cloudflare configuration or application code changed; AMPHETAMIN remains untouched and enrollment/heartbeat/dispatch remain disabled.


## I0.19 — Provisioner credential storage capability (2026-11-28)

Cloudflare Primary read-only inventory confirms an existing Secrets Store `default_secrets_store` with quota usage 0/100, no account Service Tokens, no Identity Providers, and no GROUP Access policies. The Cloudflare API contract marks Secrets Store secret values write-only and confirms they are never returned by the API. This provides a viable server-side handoff: create the Service Token and immediately write its one-time Client Secret into Secrets Store within the same server-side execution, returning only non-secret metadata. On persistence failure, disable/revoke the newly created token before returning.

The proposed secret scope is `workers`, for a future dedicated Provisioner Worker. No Provisioner Worker or binding currently exists; binding and runtime verification remain a separate deployment step. No token, secret, policy, identity provider, or Worker configuration was created or changed in this audit. GROUP remains default-deny; AMPHETAMIN is unchanged. Machine-to-machine Provisioner auth does not require a human Identity Provider.

Provisioning still requires explicit owner authorization. After approval, create one bounded-lifetime token (90 days / `2160h`), persist its secret write-only, verify metadata only, and add an Access Service Auth Allow policy matching only the returned token ID. Never emit the Client Secret in tool output, chat, logs, Git, D1, or CI.

 
## I0.20 — Provisioner token creation blocked (2026-11-28)

The owner authorized a 90-day Provisioner Service Token and write-only storage of its one-time Client Secret in Cloudflare Secrets Store. The attempted combined server-side write was blocked by the execution safety layer before the Cloudflare writes ran. A subsequent independent read-only check confirmed zero account Service Tokens, no token named `SYMBIOTYC GROUP Provisioner 90d`, zero Secrets Store secrets, and no secret named `SYMBIOTYC_GROUP_PROVISIONER_ACCESS_CLIENT_SECRET`.

No credential was generated or stored; no Access policy, Worker binding, or route changed. GROUP remains default-deny, AMPHETAMIN unchanged, and enrollment/heartbeat/dispatch disabled. This was a tool-execution safety block, not a Cloudflare API rejection. Do not retry via another tool to bypass the gate. Resume only through an explicitly supported secure credential-provisioning workflow.


## I0.21 — Provisioner runtime boundary (2026-11-28)

The current GROUP `src/index.mjs` contains no Provisioner, enrollment, heartbeat, or Worker JWT issuance/verifier route. GROUP `wrangler.jsonc` declares only the D1 `DB` binding; no Secrets Store, Provisioner service, signing-key, or verifier binding is configured. The inspected deployed Worker inventory has no separate Provisioner Worker.

This is an independent blocker beyond secure token handoff: there is no isolated runtime/deployment boundary to receive the Provisioner credential or exercise enrollment authority. Define a dedicated Provisioner Worker/service with its own entrypoint and manifest, exact-token Access Service Auth ingress, least-privilege GROUP binding, write-only secret binding, fixed issuer/audience, asymmetric signing, rotation/revocation procedure, and cross-boundary negative tests before implementing enrollment. Do not reuse AMPHETAMIN principal assertions or add enrollment routes to the existing GROUP Worker as a shortcut.

No code or Cloudflare resources changed. I0.20's credential provisioning safety block remains in force; no alternate-tool retry is permitted. GROUP stays default-deny and all worker enrollment/heartbeat/dispatch remains disabled.


## I0.22 — Provisioner runtime contract

The isolated Provisioner runtime and enrollment boundary is now specified in [docs/provisioner-runtime-contract.md](provisioner-runtime-contract.md). Its Access Service Token authenticates only the Provisioner ingress; a dedicated private Service Binding authenticates Provisioner-to-GROUP; Worker Agents redeem a one-time challenge and receive a separate GROUP-signed ES256 JWT. The new request/proof schemas and schema-level tests are indexed in the repository README. No runtime route, secret, binding, or Access policy is enabled by this contract.

## Superseding private-ingress contract — 2026-11-28

This section supersedes the earlier deployment-state statements above wherever they differ. The latest Primary-account GET-only inventory records:

- GROUP `workers.dev` disabled and Preview URLs disabled.
- No GROUP Worker Domains or Cloudflare Zones returned in the inspected account.
- AMPHETAMIN is the only observed Service Binding consumer targeting `symbiotyc-group-control-plane`.
- The one Access application returned by the inventory is attached to AMPHETAMIN; no GROUP Access application was returned.
- No live external HTTP edge request was performed in this verification. Do not claim packet-level isolation or an Access denial response.

The checked-in GROUP `wrangler.jsonc` sets `workers_dev=false` and `preview_urls=false`, with no `routes` or `custom_domains`. `tests/security-boundary.test.mjs` guards these repository invariants.

### Principal trust boundary

AMPHETAMIN calls GROUP through the private `env.GROUP.fetch(request)` Service Binding. The `x-symbiotyc-caller` marker is caller-controlled, and `x-symbiotyc-principal` is an unsigned Base64URL envelope. Neither is cryptographic authentication. GROUP may trust the asserted principal only while the Service Binding is the exclusive ingress and AMPHETAMIN is the sole authorized consumer. These headers MUST NOT authenticate public HTTP requests.

AMPHETAMIN remains responsible for authenticating the external caller and deriving tenant, project, actor, and scopes from trusted server-side context. GROUP validates assertion shape and endpoint scopes but does not treat those checks as proof of public caller identity.

### Required invariants and verification

1. Keep GROUP `workers_dev=false`, `preview_urls=false`, and `routes` / `custom_domains` absent or empty.
2. Keep AMPHETAMIN as the only Service Binding consumer of GROUP; re-read all consumers after any configuration change.
3. Fail closed on missing/wrong caller marker, malformed or oversized principal assertion, missing scope, and invalid tenant/project context.
4. Treat any public ingress or additional Service Binding consumer as a security-boundary change requiring a separate authentication design and review.
5. Distinguish control-plane configuration evidence from live network reachability; do not infer an edge deny result from Wrangler configuration or API inventory.
6. Do not create credentials, Access policies, routes, D1 migrations, or deployments as part of this repository-only contract change.

**Current gate:** private-ingress configuration and Service Binding consumer inventory are verified by read-only control-plane evidence; live runtime invocation and external edge response remain NOT_VERIFIED. Staging remains NO-GO.
