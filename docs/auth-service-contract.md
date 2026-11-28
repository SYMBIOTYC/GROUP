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
