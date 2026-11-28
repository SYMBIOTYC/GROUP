# GROUP deployment record

**Updated:** 2026-11-28  
**Deployment state:** Source and D1 schema prepared; Worker deployment is the next operation.  
**Public ingress:** Disabled by configuration; no public routes or custom domains are intended.

## Cloudflare resources

- Worker name: `symbiotyc-group-control-plane`
- D1 database: `symbiotyc-group-compute-state`
- Database ID: `633d7c14-d335-426c-be7e-2168a43171bc`
- D1 jurisdiction: `eu`
- Primary region observed: `EEUR`
- Read replication: disabled
- D1 binding: `DB`

The GROUP database is separate from the pre-existing `symbiotyc-control-state` database used by the legacy Cloud Control Plane and Assistant. Do not point GROUP at that database.

## Database verification

The new database was queried through the Cloudflare D1 API. The schema includes:

- `project_quotas`
- `project_operation_policies`
- `jobs`
- `idempotency_records`
- `executions`
- `audit_events`
- `outbox_events`

The current business tables contain no seeded tenant quotas or enabled operation policies. Consequently, `GET /v1/capabilities` reports submission unavailable until a legitimate project policy exists. No default tenant quota or operation has been invented.

## Private API boundary

The Worker is configured with:

- `workers_dev = false`
- `preview_urls = false`
- no routes or custom domains
- Workers logs and traces enabled

The `GET /v1/capabilities` endpoint requires the same internal AMPHETAMIN principal assertion and `compute:jobs:read` scope as other protected operations. It reads only the authenticated tenant/project's policy and quota state. It reports Scheduler, Dispatcher, Worker Registry, and result pipeline as not implemented, and always reports `dispatch_enabled: false`.

The principal assertion headers are trusted only over the private Service Binding. They are not cryptographic credentials and must never be accepted over public ingress. No static API token is shared between Workers.

## Activation restrictions

Even after the Worker deployment, do not enable Job submission for an operation until its tenant/project policy and quota are deliberately provisioned. Do not enable dispatch until Scheduler, atomic reservations, Dispatcher, Worker registration/heartbeat, result validation, artifact persistence, reconciliation, and full end-to-end tests exist.

A successful Job acceptance means a durable queued Job only. It is not proof that work was scheduled, dispatched, started, or completed.

## Verification commands and release evidence

- GitHub Actions runtime suite: `node --test tests/*.test.mjs`
- Contract suite: repository workflow `Compute protocol contracts`
- Runtime suite: repository workflow `GROUP runtime unit tests`
- Cloudflare verification: inspect Worker script settings, verify no public subdomain, check D1 binding points at the dedicated EU database, and call health/capabilities through the private Service Binding.

Do not publish deployment/version URLs or turn on the `workers.dev` subdomain as a temporary test method.
