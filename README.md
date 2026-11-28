# SYMBIOTYC COMPUTE GROUP

**Role:** Compute Control Plane for the SYMBIOTYC Cloud federation.  
**Protocol:** `symbiotyc.compute.v1`  
**Status:** Contract-first bootstrap; no production service or dispatch is claimed.

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

## Canonical documentation

The normative architecture, execution lifecycle, API semantics, security model, operations, and acceptance criteria are maintained in the [SYMBIOTYC Cloud Wiki](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/tree/main/Architecture/Compute-Infrastructure).

- [Compute Infrastructure index](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/README.md)
- [AMPHETAMIN MCP contract](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/AMPHETAMIN-MCP.md)
- [Compute Control Plane](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Compute-Control-Plane.md)
- [Worker Registry](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Worker-Registry.md)
- [Execution Lifecycle](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Execution-Lifecycle.md)

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

The repository now includes the initial protocol schemas, Job API source core, D1 migration, private Service Binding contract, and passing Node/Python CI. It does not implement a deployed API, provisioned database, scheduler, dispatcher, Worker agent, provider adapter, or production deployment. Production dispatch remains disabled until the security, persistence, worker, quota, artifact, and end-to-end acceptance gates pass.
