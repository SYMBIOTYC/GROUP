# AMPHETAMIN-to-GROUP Internal Service Binding Contract

**Status:** Source contract; no AMPHETAMIN Worker or GROUP deployment is claimed.

## Trust model

AMPHETAMIN is the standalone MCP ingress and authenticates its external caller. GROUP is a private Compute Control Plane. There is no shared `API_TOKEN`, bearer secret, or credential transfer between AMPHETAMIN and GROUP.

GROUP must be deployed with `workers_dev = false` and with no public routes or custom domains. The only intended ingress is a Cloudflare Worker Service Binding configured on the AMPHETAMIN Worker:

```toml
[[services]]
binding = "GROUP"
service = "symbiotyc-group-control-plane"
```

The trust of the principal assertion below depends on this network boundary. The assertion headers are not cryptographic credentials and must never be accepted over a public route. If GROUP ever needs public ingress, replace this trust model with verified OIDC/JWT or a signed service assertion before exposing it.

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

GROUP validates the caller marker, bounded assertion size, principal shape, and endpoint scope. It does not accept public bearer credentials.

## Security invariants

- GROUP has no public route, workers.dev hostname, or custom-domain route.
- Only the AMPHETAMIN Worker is configured with a Service Binding to GROUP.
- The AMPHETAMIN MCP endpoint independently authenticates external clients and authorizes project membership.
- Worker identity and Worker control remain exclusively inside GROUP; AMPHETAMIN cannot register, configure, or directly contact Workers.
- No static API_TOKEN is shared, copied, returned, or written to GitHub/Wiki.
- Service-binding configuration changes are reviewed as security-sensitive deployment changes.

## Deployment gate

Before staging deployment, verify the GROUP Worker has no public ingress and `workers_dev=false`; verify AMPHETAMIN is the sole Service Binding consumer; verify missing/wrong caller marker, malformed principal, and missing scopes fail closed. Cloudflare Access is not enabled in the inspected account, so this internal service-binding design does not depend on Access. External AMPHETAMIN authentication remains a separate prerequisite.
