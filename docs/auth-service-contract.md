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
