# SYMBIOTYC COMPUTE GROUP

**Role:** Compute Control Plane for the SYMBIOTYC Cloud federation.  
**Protocol:** `symbiotyc.compute.v1`  
**Status:** GROUP Worker is deployed in the primary Cloudflare production account with its dedicated EU D1 binding. AMPHETAMIN has a private Service Binding to GROUP. The public GROUP hostname and preview URLs are disabled. No compute dispatch is enabled.

GROUP owns compute-resource coordination across `CLOUD-COMPUTE`, `CLOUD-CPU`, and `CLOUD-VPS`. It is the authority for Worker registration and eligibility, scheduling, capacity reservations, dispatch coordination, quotas, policy, lifecycle state, and audit.

AMPHETAMIN is a separate product with its own MCP interface. It is an ingress client of GROUP; it does not administer Workers or connect to Worker endpoints directly.

## Architecture

```
AMPHETAMIN MCP
    |
    | authenticated JobIntent (symbiotyc.compute.v1)
    v
GROUP — Compute Control Plane
    |-- Worker Registry
    |-- Scheduler + atomic capacity reservation
    |-- Dispatcher + attempt/lease fencing
    |-- Quota and policy enforcement
    |-- Durable Job/Execution state + audit/outbox
    |
    +---- CLOUD-COMPUTE
    +---- CLOUD-CPU
    +---- CLOUD-VPS
```

## Repository contents

- `contracts/` — machine-readable protocol schemas.
- `docs/architecture.md` — authority boundaries and component model.
- `tests/` — schema conformance tests.
- `wrangler.toml` — private Worker configuration with `workers_dev=false`, `preview_urls=false`, no routes, and the dedicated EU D1 binding.

## Canonical documentation

The normative architecture, execution lifecycle, API semantics, security model, operations, and acceptance criteria are maintained in the [SYMBIOTYC Cloud Wiki](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/tree/main/Architecture/Compute-Infrastructure).

- [Compute Infrastructure index](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/README.md)
- [AMPHETAMIN MCP contract](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/AMPHETAMIN-MCP.md)
- [Compute Control Plane](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Compute-Control-Plane.md)
- [Worker Registry](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Worker-Registry.md)\n- [AMPHETAMIN quality-weighted randomized Worker scaling](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/AMPHETAMIN-Quality-Weighted-Random-Worker-Scaling.md)
- [Execution Lifecycle](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Execution-Lifecycle.md)
- [Live deployment verification (2026-11-28)](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Live-Deployment-Verification-2026-11-28.md)

## Security invariants

- Tenant, project, actor, and Worker trust are derived from authenticated server-side identity, never from caller-controlled request fields.
- AMPHETAMIN submits JobIntent and reads authorized results only; it has no direct Worker control.
- Worker classes and capabilities are allowlisted by GROUP policy. A Worker cannot grant itself trust or raise its own quota.
- Jobs are bounded by operation allowlists, resource ceilings, deadlines, tenant quotas, and sandbox profiles.
- Idempotency is atomically claimed and payload-digest bound. Ambiguous outcomes are reconciled; retries never create a new intent.
- Worker messages are fenced by authenticated identity, execution ID, and current lease epoch/token.
- TaskResult is untrusted until schema, attempt, lease, output, and artifact integrity validation succeeds.
- Audit and state transitions are durable and append-only; secrets and raw credentials never enter repository files or audit payloads.

## Deployment configuration

- [GROUP deployment record](docs/deployment-record.md)
- [Cloudflare Worker configuration](wrangler.jsonc)

## Implementation status

The repository includes the initial protocol schemas, Job API source core, D1 migration, private Service Binding contract, and passing Node/Python CI. The dedicated EU D1 database `symbiotyc-group-compute-state` has been provisioned and the initial migration applied and verified. The GROUP Worker `symbiotyc-group-control-plane` is deployed with the dedicated D1 binding; its `workers.dev` subdomain and preview URLs are disabled. The AMPHETAMIN Worker has a live `GROUP` Service Binding to this service. The Access-protected MCP edge exposes only the read-only `group.health` probe. An authenticated external MCP round-trip has not yet been verified. Scheduler, dispatcher, Worker agent, provider adapter, result/artifact pipeline, and production dispatch remain disabled until the end-to-end acceptance gates pass.

The dated [live deployment verification](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Live-Deployment-Verification-2026-11-28.md) records the account-side evidence and remaining gaps. A Worker script existing in the account is not proof that the complete compute lifecycle is operational.


## One-time compute approval service

PR #10 adds the private approval API and the D1 migration `0003_compute_approvals.sql`.

- `POST /v1/approvals` requires `compute:approvals:write`, a private AMPHETAMIN caller assertion, and an Idempotency-Key. It binds an approval to tenant, project, actor, action, operation, request SHA-256, and a 30–300 second TTL.
- `POST /v1/approvals/{approval_id}/consume` requires `compute:approvals:consume` and atomically consumes the matching approval exactly once.
- Submit approvals require an enabled project operation policy and configured quota.
- Cancel approvals require an existing non-terminal Job in the same tenant/project.
- Approval claims are immutable; approvals cannot be deleted; audit events are append-only.

**Production state (2026-11-28):** The D1 migration has been applied and recorded in `d1_migrations` alongside the existing 0001 and 0002 baseline. The table, index, and three triggers are present. The GROUP Worker source contains the new routes on `main`, but the live Worker has not yet been upgraded; the Cloudflare upload was blocked by the security layer. These endpoints are therefore not yet active in production. GROUP remains private with `workers_dev=false` and `preview_urls=false`.
