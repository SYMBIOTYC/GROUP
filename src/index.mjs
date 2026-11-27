import { canonicalJson, sha256Hex, validateJobIntent } from "./job-intent.mjs";

const SERVICE_NAME = "symbiotyc-group-control-plane";
const MAX_BODY_BYTES = 1024 * 1024;
const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

function errorResponse(status, code, message, correlationId) {
  return jsonResponse(status, {
    error: { code, message, correlation_id: correlationId }
  });
}

function correlationId(request) {
  const supplied = request.headers.get("x-correlation-id");
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID();
}

async function authorize(request, env, scope, correlation) {
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
    return { response: errorResponse(401, "AUTHENTICATION_REQUIRED", "A valid bearer credential is required.", correlation) };
  }
  if (!env?.AUTH_SERVICE || typeof env.AUTH_SERVICE.fetch !== "function") {
    return { response: errorResponse(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Trusted identity verification is not configured.", correlation) };
  }

  let upstream;
  try {
    upstream = await env.AUTH_SERVICE.fetch(new Request("https://identity.internal/v1/verify", {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "x-required-scope": scope
      },
      body: JSON.stringify({ audience: SERVICE_NAME, required_scopes: [scope] })
    }));
  } catch {
    return { response: errorResponse(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Trusted identity verification is unavailable.", correlation) };
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return { response: errorResponse(upstream.status, upstream.status === 401 ? "AUTHENTICATION_REQUIRED" : "FORBIDDEN", "The caller is not authorized for this operation.", correlation) };
  }
  if (!upstream.ok) {
    return { response: errorResponse(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Trusted identity verification failed.", correlation) };
  }

  let verified;
  try {
    verified = await upstream.json();
  } catch {
    return { response: errorResponse(503, "IDENTITY_PROVIDER_INVALID_RESPONSE", "Trusted identity provider returned an invalid response.", correlation) };
  }
  const principal = verified?.principal;
  if (verified?.ok !== true || !principal ||
      !["user", "service"].includes(principal.kind) ||
      typeof principal.tenant_id !== "string" ||
      typeof principal.project_id !== "string" ||
      typeof principal.actor_id !== "string" ||
      !Array.isArray(principal.scopes)) {
    return { response: errorResponse(503, "IDENTITY_PROVIDER_INVALID_RESPONSE", "Trusted identity provider returned an incomplete principal.", correlation) };
  }
  if (!principal.scopes.includes(scope)) {
    return { response: errorResponse(403, "FORBIDDEN", "The caller lacks the required scope.", correlation) };
  }
  return { principal };
}

function databaseUnavailable(env, correlation) {
  return !env?.DB || typeof env.DB.prepare !== "function" || typeof env.DB.batch !== "function"
    ? errorResponse(503, "DATABASE_UNAVAILABLE", "Durable Job storage is not configured.", correlation)
    : null;
}

function parseJobRow(row) {
  if (!row) return null;
  return {
    job_id: row.job_id,
    operation_id: row.operation_id,
    state: row.state,
    record_version: row.record_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deadline_at: row.deadline_at,
    correlation_id: row.correlation_id
  };
}

async function createJob(request, env, principal, correlation) {
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    return errorResponse(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key must be 8–128 safe characters and stable across retries.", correlation);
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return errorResponse(415, "UNSUPPORTED_MEDIA_TYPE", "JobIntent must be submitted as application/json.", correlation);
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return errorResponse(413, "REQUEST_TOO_LARGE", "Request body exceeds the 1 MiB limit.", correlation);
  }
  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return errorResponse(413, "REQUEST_TOO_LARGE", "Request body exceeds the 1 MiB limit.", correlation);
    }
    body = JSON.parse(raw);
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must contain valid JSON.", correlation);
  }
  const validation = validateJobIntent(body);
  if (!validation.ok) return errorResponse(422, validation.error.code, validation.error.message, correlation);

  const dbError = databaseUnavailable(env, correlation);
  if (dbError) return dbError;

  const intent = validation.value;
  const { tenant_id: tenantId, project_id: projectId, actor_id: actorId } = principal;
  const policy = await env.DB.prepare(
    "SELECT enabled, max_cpu_millis_per_job, max_memory_mib_per_job, max_timeout_seconds FROM project_operation_policies WHERE tenant_id = ? AND project_id = ? AND operation_id = ?"
  ).bind(tenantId, projectId, intent.operation_id).first();
  if (!policy || policy.enabled !== 1) {
    return errorResponse(403, "OPERATION_NOT_ALLOWED", "The requested operation is not enabled for this project.", correlation);
  }
  const quota = await env.DB.prepare(
    "SELECT active_jobs, max_active_jobs, max_cpu_millis_per_job, max_memory_mib_per_job, max_timeout_seconds FROM project_quotas WHERE tenant_id = ? AND project_id = ?"
  ).bind(tenantId, projectId).first();
  if (!quota) {
    return errorResponse(403, "QUOTA_NOT_CONFIGURED", "No compute quota is configured for this project.", correlation);
  }
  const cpuLimit = Math.min(policy.max_cpu_millis_per_job, quota.max_cpu_millis_per_job);
  const memoryLimit = Math.min(policy.max_memory_mib_per_job, quota.max_memory_mib_per_job);
  const timeoutLimit = Math.min(policy.max_timeout_seconds, quota.max_timeout_seconds);
  if (intent.constraints.cpu_millis > cpuLimit ||
      intent.constraints.memory_mib > memoryLimit ||
      intent.constraints.timeout_seconds > timeoutLimit) {
    return errorResponse(422, "RESOURCE_LIMIT_EXCEEDED", "Requested resources exceed the operation or project policy.", correlation);
  }
  if (quota.active_jobs >= quota.max_active_jobs) {
    return errorResponse(429, "QUOTA_EXCEEDED", "The project has reached its active Job quota.", correlation);
  }

  const requestHash = await sha256Hex(canonicalJson(intent));
  const idempotencyHash = await sha256Hex(idempotencyKey);
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const constraintsJson = JSON.stringify(intent.constraints);
  const outputPolicyJson = JSON.stringify(intent.output_policy);
  const inputJson = JSON.stringify(intent.input);
  const eventId = crypto.randomUUID();

  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO idempotency_records (tenant_id, project_id, operation_id, idempotency_key_hash, request_hash, job_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)"
      ).bind(tenantId, projectId, intent.operation_id, idempotencyHash, requestHash, now),
      env.DB.prepare(
        "UPDATE project_quotas SET active_jobs = active_jobs + 1, updated_at = ? WHERE tenant_id = ? AND project_id = ? AND active_jobs < max_active_jobs AND changes() = 1 AND EXISTS (SELECT 1 FROM project_operation_policies p WHERE p.tenant_id = ? AND p.project_id = ? AND p.operation_id = ? AND p.enabled = 1 AND ? <= p.max_cpu_millis_per_job AND ? <= p.max_memory_mib_per_job AND ? <= p.max_timeout_seconds)"
      ).bind(now, tenantId, projectId, tenantId, projectId, intent.operation_id, intent.constraints.cpu_millis, intent.constraints.memory_mib, intent.constraints.timeout_seconds),
      env.DB.prepare(
        "INSERT INTO jobs (job_id, tenant_id, project_id, actor_id, operation_id, input_json, constraints_json, output_policy_json, state, record_version, request_digest, correlation_id, created_at, updated_at, deadline_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', 1, ?, ?, ?, ?, ? WHERE changes() = 1"
      ).bind(jobId, tenantId, projectId, actorId, intent.operation_id, inputJson, constraintsJson, outputPolicyJson, requestHash, correlation, now, now, intent.deadline_at || null),
      env.DB.prepare(
        "UPDATE idempotency_records SET job_id = ? WHERE tenant_id = ? AND project_id = ? AND operation_id = ? AND idempotency_key_hash = ? AND job_id IS NULL AND changes() = 1"
      ).bind(jobId, tenantId, projectId, intent.operation_id, idempotencyHash),
      env.DB.prepare(
        "INSERT INTO audit_events (event_id, tenant_id, project_id, actor_id, action, resource_id, request_digest, correlation_id, created_at) SELECT ?, ?, ?, ?, 'JOB_CREATED', ?, ?, ?, ? WHERE changes() = 1"
      ).bind(eventId, tenantId, projectId, actorId, jobId, requestHash, correlation, now),
      env.DB.prepare(
        "INSERT INTO outbox_events (event_id, tenant_id, project_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_json, created_at) SELECT ?, ?, ?, 'JOB', ?, 1, 'JOB_ACCEPTED', ?, ? WHERE changes() = 1"
      ).bind(crypto.randomUUID(), tenantId, projectId, jobId, JSON.stringify({ job_id: jobId, state: "QUEUED", operation_id: intent.operation_id }), now),
      env.DB.prepare(
        "DELETE FROM idempotency_records WHERE tenant_id = ? AND project_id = ? AND operation_id = ? AND idempotency_key_hash = ? AND job_id IS NULL"
      ).bind(tenantId, projectId, intent.operation_id, idempotencyHash)
    ]);
  } catch {
    return errorResponse(503, "DURABLE_WRITE_FAILED", "Job acceptance could not be durably committed; retry only with the same Idempotency-Key.", correlation);
  }

  const idempotency = await env.DB.prepare(
    "SELECT request_hash, job_id FROM idempotency_records WHERE tenant_id = ? AND project_id = ? AND operation_id = ? AND idempotency_key_hash = ?"
  ).bind(tenantId, projectId, intent.operation_id, idempotencyHash).first();
  if (!idempotency) {
    return errorResponse(429, "QUOTA_OR_POLICY_CHANGED", "Project quota or operation policy changed before the Job could be accepted.", correlation);
  }
  if (idempotency.request_hash !== requestHash) {
    return errorResponse(409, "IDEMPOTENCY_CONFLICT", "The Idempotency-Key was already used with a different JobIntent.", correlation);
  }
  if (!idempotency.job_id) {
    return errorResponse(503, "JOB_ACCEPTANCE_UNKNOWN", "The durable acceptance outcome is unresolved; retry only with the same Idempotency-Key.", correlation);
  }
  const row = await env.DB.prepare(
    "SELECT job_id, operation_id, state, record_version, created_at, updated_at, deadline_at, correlation_id FROM jobs WHERE job_id = ? AND tenant_id = ? AND project_id = ?"
  ).bind(idempotency.job_id, tenantId, projectId).first();
  if (!row) return errorResponse(503, "JOB_RECORD_UNAVAILABLE", "The accepted Job record could not be read back.", correlation);
  const replayed = idempotency.job_id !== jobId;
  return jsonResponse(202, { ...parseJobRow(row), status_url: `/v1/jobs/${row.job_id}`, replayed });
}

async function getJob(env, principal, jobId, correlation) {
  const dbError = databaseUnavailable(env, correlation);
  if (dbError) return dbError;
  const row = await env.DB.prepare(
    "SELECT job_id, operation_id, state, record_version, created_at, updated_at, deadline_at, correlation_id FROM jobs WHERE job_id = ? AND tenant_id = ? AND project_id = ?"
  ).bind(jobId, principal.tenant_id, principal.project_id).first();
  if (!row) return errorResponse(404, "JOB_NOT_FOUND", "The requested Job was not found.", correlation);
  return jsonResponse(200, parseJobRow(row));
}

async function cancelJob(env, principal, jobId, correlation) {
  const dbError = databaseUnavailable(env, correlation);
  if (dbError) return dbError;
  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE jobs SET state = 'CANCEL_REQUESTED', record_version = record_version + 1, updated_at = ? WHERE job_id = ? AND tenant_id = ? AND project_id = ? AND state IN ('QUEUED', 'SCHEDULED', 'DISPATCHED', 'RUNNING')"
      ).bind(now, jobId, principal.tenant_id, principal.project_id),
      env.DB.prepare(
        "INSERT INTO audit_events (event_id, tenant_id, project_id, actor_id, action, resource_id, correlation_id, created_at) SELECT ?, ?, ?, ?, 'JOB_CANCEL_REQUESTED', ?, ?, ? WHERE changes() = 1"
      ).bind(eventId, principal.tenant_id, principal.project_id, principal.actor_id, jobId, correlation, now),
      env.DB.prepare(
        "INSERT INTO outbox_events (event_id, tenant_id, project_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_json, created_at) SELECT ?, ?, ?, 'JOB', ?, (SELECT record_version FROM jobs WHERE job_id = ?), 'JOB_CANCEL_REQUESTED', ?, ? WHERE changes() = 1"
      ).bind(crypto.randomUUID(), principal.tenant_id, principal.project_id, jobId, jobId, JSON.stringify({ job_id: jobId, state: "CANCEL_REQUESTED" }), now)
    ]);
  } catch {
    return errorResponse(503, "DURABLE_WRITE_FAILED", "Cancellation request could not be durably committed.", correlation);
  }
  const row = await env.DB.prepare(
    "SELECT job_id, operation_id, state, record_version, created_at, updated_at, deadline_at, correlation_id FROM jobs WHERE job_id = ? AND tenant_id = ? AND project_id = ?"
  ).bind(jobId, principal.tenant_id, principal.project_id).first();
  if (!row) return errorResponse(404, "JOB_NOT_FOUND", "The requested Job was not found.", correlation);
  if (TERMINAL_STATES.has(row.state)) {
    return errorResponse(409, "JOB_ALREADY_TERMINAL", "A terminal Job cannot be cancelled.", correlation);
  }
  return jsonResponse(202, parseJobRow(row));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const correlation = correlationId(request);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(200, {
        status: "ok",
        service: SERVICE_NAME,
        protocol: "symbiotyc.compute.v1",
        dispatch_enabled: false
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/jobs") {
      const auth = await authorize(request, env, "compute:jobs:write", correlation);
      if (auth.response) return auth.response;
      return createJob(request, env, auth.principal, correlation);
    }

    const getMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]{36})$/i);
    if (request.method === "GET" && getMatch) {
      const auth = await authorize(request, env, "compute:jobs:read", correlation);
      if (auth.response) return auth.response;
      return getJob(env, auth.principal, getMatch[1], correlation);
    }

    const cancelMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]{36})\/cancel$/i);
    if (request.method === "POST" && cancelMatch) {
      const auth = await authorize(request, env, "compute:jobs:cancel", correlation);
      if (auth.response) return auth.response;
      return cancelJob(env, auth.principal, cancelMatch[1], correlation);
    }

    return errorResponse(404, "NOT_FOUND", "The requested endpoint does not exist.", correlation);
  }
};
