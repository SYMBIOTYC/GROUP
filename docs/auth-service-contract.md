# AMPHETAMIN-to-GROUP Internal Service Binding Contract

**Status:** Private Service Binding trust contract. Repository configuration and the 2026-11-28 GET-only Cloudflare inventory agree that GROUP has no configured public Worker ingress in the inspected primary account. A live external edge probe was not performed; do not overstate this as a packet-level reachability test.

## Verified deployment posture — 2026-11-28

The primary Cloudflare profile read-back recorded:

- GROUP Worker: `workers.dev` disabled; Preview URLs disabled.
- GROUP Worker Domains: none returned; account Worker Domains total: zero.
- Cloudflare Zones: zero returned for the account; external DNS providers and other Cloudflare accounts are outside this inventory.
- Service Binding consumers: AMPHETAMIN is the only Worker found targeting `symbiotyc-group-control-plane`.
- Access applications: one application returned, attached to AMPHETAMIN. No GROUP Access application was present in the returned inventory.
- No live HTTP request or Access edge allow/deny probe was performed.

The checked-in `wrangler.jsonc` independently sets `workers_dev=false` and `preview_urls=false`, with no `routes` or `custom_domains`. CI now guards these private-ingress invariants in `tests/security-boundary.test.mjs`.

**Evidence boundary:** these are configuration and control-plane inventory facts, not a live network isolation test. Do not claim an external request was blocked by Cloudflare Access; GROUP is not protected by the AMPHETAMIN Access application. Any future ingress/configuration change requires a new read-back and security review.

## Intended trust model

AMPHETAMIN is the standalone MCP ingress and authenticates its external caller. GROUP is the Compute Control Plane. The only intended GROUP application ingress is the Cloudflare Worker Service Binding configured on AMPHETAMIN:

```toml
[[services]]
binding = "GROUP"
service = "symbiotyc-group-control-plane"
```

There is no shared `API_TOKEN`, bearer secret, or credential transfer between AMPHETAMIN and GROUP. The private Service Binding is the caller-authentication boundary.

The headers below are an internal principal assertion, not a cryptographic credential. They MUST NOT be accepted as proof of caller identity over public HTTP. The `x-symbiotyc-caller` value is caller-controlled and the Base64URL principal is unsigned; their integrity depends on the request being delivered only through the private Service Binding. If public ingress is ever enabled, this contract is no longer sufficient and the change must be blocked pending a separately reviewed authentication design.

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

GROUP validates the caller marker, bounded assertion size, principal shape, and endpoint scope. These checks validate the assertion's shape and requested authorization scope; they do not independently authenticate a public caller. The current trust decision is therefore conditional on the private ingress invariant above.

## Security invariants

- `workers_dev=false` and `preview_urls=false` remain mandatory.
- GROUP `routes` and `custom_domains` remain absent/empty.
- AMPHETAMIN remains the sole Service Binding consumer of GROUP.
- The AMPHETAMIN MCP endpoint independently authenticates external clients and authorizes project membership.
- Tenant, project, actor, and scopes are derived server-side; caller-supplied tool arguments cannot override them.
- Worker identity and Worker control remain exclusively inside GROUP; AMPHETAMIN cannot register, configure, or directly contact Workers.
- No static API token is shared, copied, returned, or written to GitHub/Wiki.
- Service-binding and public-exposure configuration changes are security-sensitive and require review.
- No Worker enrollment/heartbeat route is enabled by this contract; Worker Registry trust gates remain separate.

## Verification and change gate

1. Keep the GROUP Wrangler ingress guard tests passing in CI.
2. After any deployment/configuration change, read back the per-Worker `workers.dev` and Preview URL flags, Worker Domains, routes/custom domains, and all Service Binding consumers.
3. Confirm AMPHETAMIN remains the sole Service Binding consumer.
4. Keep malformed principal, missing/wrong caller marker, and missing-scope requests fail-closed in GROUP tests.
5. Do not infer live edge isolation from repository config or control-plane inventory alone. If a deployment introduces a hostname or route, require a separately authorized non-production edge verification before relying on the new boundary.
6. Do not provision credentials, create Access policies, change routes, or deploy Workers as part of this repository-only contract update.

External AMPHETAMIN authentication remains a separate prerequisite. Staging and production dispatch remain subject to their existing approval gates.

## Historical pre-reverification deployment gate — superseded snapshot

The following exact tail from the prior contract revision is retained only to preserve the historical merge-base record. Its statements about GROUP workers.dev and Access are superseded by the current verified posture at the beginning of this document.

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
