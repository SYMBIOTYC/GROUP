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
