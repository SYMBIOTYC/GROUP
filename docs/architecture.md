# GROUP Compute Control Plane Architecture

**Protocol:** `symbiotyc.compute.v1`  
**Status:** Target architecture; implementation is not yet production-ready.

## 1. System authority

GROUP is the control plane for compute capacity owned or delegated by SYMBIOTYC. It coordinates the execution pools `CLOUD-COMPUTE`, `CLOUD-CPU`, and `CLOUD-VPS`.

AMPHETAMIN is a standalone product and MCP server. It authenticates the user at its own boundary, validates the requested operation, and calls GROUP over the versioned protocol. AMPHETAMIN is not a scheduler, worker registry, dispatcher, or worker administrator.

## 2. Responsibility split

| Component | Owns | Explicitly does not own |
|---|---|---|
| AMPHETAMIN MCP | User-facing tools, JobIntent shaping, status/result presentation | Worker selection, Worker credentials, capacity, leases, Job state |
| GROUP API | Private internal API, tenant/project policy, Job state, idempotency, quotas, audit | External user authentication, workload execution, direct Worker administration |
| Worker Registry | Worker identity, registration epoch, capabilities, health, capacity observations, drain/quarantine/revoke | Job state or result acceptance |
| Scheduler | Candidate eligibility, placement scoring, fairness, reservation request | Durable Job lifecycle |
| Dispatcher | Attempt-bound delivery, ACK, cancellation delivery, reconciliation | Creating a new user intent |
| Worker Runtime | Isolated execution, bounded resource use, result report | Declaring Job success or extending its own lease |
| CLOUD-COMPUTE / CPU / VPS | Provider-specific execution capacity | Global policy or tenant authorization |

## 3.1 AMPHETAMIN-to-GROUP internal boundary

GROUP is not a public API. It is deployed with `workers_dev=false`, `preview_urls=false`, no public routes, no custom domain, and no unprotected deployment URL. AMPHETAMIN is the only intended consumer through a Cloudflare Service Binding. AMPHETAMIN authenticates the external MCP caller and derives tenant/project/actor/scopes from its trusted session and membership policy. It then sends a bounded principal assertion to GROUP over the internal binding.

The principal assertion headers are not cryptographic credentials. They are trusted only because the GROUP Worker has no public ingress and only AMPHETAMIN is configured with the Service Binding. Never expose those headers over public HTTP. This removes the need for a shared static `API_TOKEN` between AMPHETAMIN and GROUP. See [the internal Service Binding contract](auth-service-contract.md).


## 2.1 Worker identity and enrollment gate

The normative v1 enrollment and credential contract is [Worker Identity and Enrollment Contract](worker-identity-and-enrollment-contract.md). AMPHETAMIN is not a Worker administrator or enrollment authority. Worker Registry endpoints remain unimplemented until a separate authenticated infrastructure provisioner and enrollment channel are deployed and verified. Do not add heartbeat routes that trust the AMPHETAMIN principal as Worker identity.

## 3. Trust boundaries

1. AMPHETAMIN-to-GROUP: private Cloudflare Service Binding only; AMPHETAMIN authenticates the external caller and derives tenant/project/actor/scopes server-side. GROUP has no public route and accepts the bounded principal assertion only on that internal path.
2. GROUP-to-Worker: authenticated workload identity, short-lived registration epoch, attempt-bound lease/fencing token, allowlisted capabilities, bounded TaskRequest.
3. Worker-to-GROUP: authenticated result/status messages; all payloads are untrusted and must be checked against current Job, Execution, Worker, lease, deadline, and output policy.
4. GROUP-to-provider: least-privilege provider adapters with provider-enforced quota discovery; missing or stale capacity evidence fails closed.

No caller-provided endpoint URL, command, credential, tenant ID, Worker ID, or policy claim may override trusted server-side configuration. Principal assertion headers are not safe on public ingress; the private Service Binding boundary is mandatory.

## 4. Job lifecycle

The authoritative lifecycle is specified in the Cloud Wiki [Execution Lifecycle](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Execution-Lifecycle.md). GROUP must persist Job and Execution Attempt state before external side effects.

- Job creation atomically claims `(tenant, project, operation, idempotency_key)` and binds it to a canonical request digest.
- Same key and same digest replays the original Job; same key with a different digest returns `409 IDEMPOTENCY_CONFLICT`.
- Scheduler preview is read-only. Production placement requires an atomic capacity reservation.
- Each execution attempt has an immutable ID, attempt number, Worker assignment, lease epoch/token, and deadline.
- Delivery is at-least-once. Consumers deduplicate by stable message ID.
- Worker loss and ambiguous delivery are reconciled from durable state before any retry.
- Job success is committed only after result and artifact validation and durable storage.
- Cancellation is a durable command; `CANCEL_REQUESTED` is not the same as terminal `CANCELLED`.

## 5. Data and transaction requirements

The implementation must provide durable records for Jobs, Execution Attempts, idempotency claims, capacity reservations, Worker registrations/epochs, execution receipts, artifact manifests, audit events, outbox events, and consumer inbox deduplication.

State transition, audit event, and outbox event must commit atomically. Enforce uniqueness using database constraints or an equivalent single-winner primitive; a read-then-write check is not sufficient.

Every data access path is tenant/project scoped. Terminal states and prior attempt history are immutable.

## 6. Worker pools

- `CLOUD-COMPUTE`: orchestration and approved general compute capacity.
- `CLOUD-CPU`: bounded CPU execution workers.
- `CLOUD-VPS`: persistent edge/host capacity, isolated from public pull-request workloads.

Pool membership, capability, concurrency, and trust are separate attributes. Public PR workflows must remain on ephemeral GitHub-hosted runners and must never be dispatched to persistent production VPS/CPU workers.

## 7. API and protocol

Machine-readable request schemas are stored in `contracts/`. The canonical endpoint semantics and error mapping are maintained in the Cloud Wiki [Compute Control Plane](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Compute-Control-Plane.md) and [Compute Protocol](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Compute-Protocol.md).

The first external API surface is:
- `POST /v1/jobs`
- `GET /v1/jobs/{job_id}`
- `POST /v1/jobs/{job_id}/cancel`
- `GET /v1/jobs/{job_id}/executions`
- `GET /v1/executions/{execution_id}`
- `GET /v1/jobs/{job_id}/result`
- `POST /v1/workers/register`
- `POST /v1/workers/{worker_id}/heartbeat`
- `POST /v1/workers/{worker_id}/drain`
- `POST /v1/workers/{worker_id}/revoke`

All mutating endpoints require idempotency or version preconditions and an append-only audit record. List endpoints require bounded pagination.

## 8. Explicit non-goals

- No arbitrary privileged shell, host filesystem mount, Docker socket, or unrestricted network access.
- No direct AMPHETAMIN-to-Worker connection or Worker administration.
- No user-supplied provider credentials or endpoint URLs.
- No self-declared Worker trust level or caller-supplied tenant authorization.
- No production dispatch based only on a passing contract CI or a Scheduler preview.
- No exactly-once transport assumption.

## 9. Implementation sequence

1. Freeze protocol schemas and conformance fixtures.
2. Implement durable identity, tenant policy, Job/idempotency, audit, and outbox.
3. Implement Worker registration, heartbeat sequence, liveness, drain, quarantine, and revoke.
4. Implement Scheduler eligibility and atomic reservation.
5. Implement Dispatcher delivery, ACK, fencing, cancellation, and reconciliation.
6. Implement isolated Worker Runtime and provider adapters.
7. Implement result validation and immutable artifact storage.
8. Connect AMPHETAMIN MCP only to the authenticated Job API.
9. Pass tenant isolation, quota, idempotency, restart recovery, failure injection, and end-to-end acceptance tests.
10. Enable production dispatch only after the full release gate is evidenced.
