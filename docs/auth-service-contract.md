# GROUP Trusted Identity Service Binding

**Status:** Required integration contract; no identity service binding is currently configured or claimed.

GROUP does not parse caller-provided tenant, project, actor, Worker, role, or scope claims. It delegates credential verification to a trusted Cloudflare Worker Service Binding named `AUTH_SERVICE`.

## Request

GROUP calls the service binding at the internal path `POST https://identity.internal/v1/verify` with:

- the original Authorization header, forwarded only over the trusted Worker Service Binding;
- `x-required-scope` containing the endpoint-specific permission;
- JSON body `{ "audience": "symbiotyc-group-control-plane", "required_scopes": ["..."] }`.

The raw credential is never copied into a URL, JSON body, database row, audit event, or response.

## Required response

A successful verifier returns JSON:

```json
{
  "ok": true,
  "principal": {
    "kind": "user",
    "tenant_id": "tenant-from-trusted-identity",
    "project_id": "project-from-trusted-identity",
    "actor_id": "subject-from-trusted-identity",
    "scopes": ["compute:jobs:write"]
  }
}
```

Allowed principal kinds for Job API calls are `user` and `service`. Worker endpoints will use a separate `worker` principal contract and cannot reuse user scopes.

The verifier must validate issuer, audience, signature, expiry, not-before, tenant/project membership, and scope assignment before returning the principal. It must fail closed for unknown issuers, stale keys, invalid claims, and unavailable policy data.

## Failure semantics

- Missing Authorization: `401 AUTHENTICATION_REQUIRED`.
- Invalid credential: `401 AUTHENTICATION_REQUIRED`.
- Authenticated but insufficient scope: `403 FORBIDDEN`.
- Missing binding, timeout, invalid verifier response, or verifier failure: `503 IDENTITY_PROVIDER_UNAVAILABLE` or `503 IDENTITY_PROVIDER_INVALID_RESPONSE`.

## Deployment gate

Do not deploy the GROUP Worker until the trusted identity service exists, its issuer/audience/scope policy is verified, and positive/negative authentication tests pass. Do not substitute a static `API_TOKEN`, user-supplied tenant ID, or caller-controlled claims.
