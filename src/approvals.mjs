import { sha256Hex } from "./job-intent.mjs";

const MAX_BODY_BYTES = 8192;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const OPERATION_RE = /^[a-z][a-z0-9_.-]{1,127}$/;
const ACTIONS = new Set(["job.submit", "job.cancel"]);
const CANCELABLE_STATES = new Set(["QUEUED", "SCHEDULED", "DISPATCHED", "RUNNING"]);

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function errorResponse(status, code, message, correlation) {
  return jsonResponse(status, { error: { code, message, correlation_id: correlation } });
}

function databaseUnavailable(env, correlation) {
  return !env?.DB || typeof env.DB.prepare !== "function" || typeof env.DB.batch !== "function"
    ? errorResponse(503, "DATABASE_UNAVAILABLE", "Durable approval storage is not configured.", correlation)
    : null;
}

async function readTextLimited(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) throw new RangeError("request body too large");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("request body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function parseBody(request, correlation) {
  if (!(request.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
    return { response: errorResponse(415, "UNSUPPORTED_MEDIA_TYPE", "Approval requests must use application/json.", correlation) };
  }
  try {
    const body = JSON.parse(await readTextLimited(request));
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.getPrototypeOf(body) !== Object.prototype) {
      return { response: errorResponse(400, "INVALID_APPROVAL_REQUEST", "Approval request must be a JSON object.", correlation) };
    }
    return { body };
  } catch (error) {
    if (error instanceof RangeError) {
      return { response: errorResponse(413, "REQUEST_TOO_LARGE", "Approval request exceeds the 8 KiB limit.", correlation) };
    }
    return { response: errorResponse(400, "INVALID_JSON", "Approval request must contain valid UTF-8 JSON.", correlation) };
  }
}

function principalHas(principal, scope) {
  return principal && principal.kind === "user" &&
    typeof principal.tenant_id === "string" && principal.tenant_id.length > 0 &&
    typeof principal.project_id === "string" && principal.project_id.length > 0 &&
    typeof principal.actor_id === "string" && principal.actor_id.length > 0 &&
    Array.isArray(principal.scopes) && principal.scopes.includes(scope);
}

function readApprovalRow(row, replayed = false) {
  return {
    approval_id: row.approval_id,
    action: row.action,
    operation_id: row.operation_id,
    request_hash: row.request_hash,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    ...(row.target_id ? { target_id: row.target_id } : {}),
    replayed
  };
}

async function findExisting(env, principal, action, keyHash) {
  return env.DB.prepare(
    "SELECT approval_id, action, operation_id, request_hash, status, created_at, expires_at, target_id FROM compute_approvals WHERE tenant_id = ? AND project_id = ? AND actor_id = ? AND action = ? AND idempotency_key_hash = ?"
  ).bind(principal.tenant_id, principal.project_id, principal.actor_id, action, keyHash).first();
}

function existingResponse(row, action, operationId, requestHash, targetId, now, correlation) {
  if (row.request_hash !== requestHash || row.operation_id !== operationId || (row.target_id || null) !== (targetId || null)) {
    return errorResponse(409, "APPROVAL_IDEMPOTENCY_CONFLICT", "The Idempotency-Key was already used for a different approval request.", correlation);
  }
  if (row.status === "consumed") {
    return errorResponse(409, "APPROVAL_ALREADY_CONSUMED", "This approval has already been consumed.", correlation);
  }
  if (row.status !== "pending" || row.expires_at <= now) {
    return errorResponse(410, "APPROVAL_EXPIRED", "This approval is no longer valid.", correlation);
  }
  return jsonResponse(200, readApprovalRow(row, true));
}

export async function createApproval(request, env, principal, correlation) {
  const dbError = databaseUnavailable(env, correlation);
  if (dbError) return dbError;
  if (!principalHas(principal, "compute:approvals:write")) {
    return errorResponse(403, "FORBIDDEN", "The principal lacks the approval creation scope.", correlation);
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    return errorResponse(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key must be 8–128 safe characters.", correlation);
  }
  const parsed = await parseBody(request, correlation);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  const allowed = new Set(["action", "operation_id", "request_hash", "ttl_seconds", "target_id"]);
  if (Object.keys(body).some(key => !allowed.has(key)) ||
      !ACTIONS.has(body.action) ||
      typeof body.operation_id !== "string" || !OPERATION_RE.test(body.operation_id) ||
      typeof body.request_hash !== "string" || !HASH_RE.test(body.request_hash)) {
    return errorResponse(400, "INVALID_APPROVAL_REQUEST", "Action, operation_id, and a SHA-256 request_hash are required.", correlation);
  }
  const ttl = body.ttl_seconds === undefined ? 120 : body.ttl_seconds;
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > 300) {
    return errorResponse(400, "INVALID_APPROVAL_TTL", "Approval TTL must be between 30 and 300 seconds.", correlation);
  }
  if (body.action === "job.submit" && (body.operation_id === "job.cancel" || body.target_id !== undefined)) {
    return errorResponse(400, "INVALID_APPROVAL_TARGET", "Submit approvals require an operation_id and no target_id.", correlation);
  }
  if (body.action === "job.cancel" && (body.operation_id !== "job.cancel" || typeof body.target_id !== "string" || !UUID_RE.test(body.target_id))) {
    return errorResponse(400, "INVALID_APPROVAL_TARGET", "Cancel approvals require operation_id job.cancel and a UUID target_id.", correlation);
  }

  const keyHash = await sha256Hex(idempotencyKey);
  const now = new Date().toISOString();
  try {
    const existing = await findExisting(env, principal, body.action, keyHash);
    if (existing) return existingResponse(existing, body.action, body.operation_id, body.request_hash, body.target_id || null, now, correlation);
  } catch {
    return errorResponse(503, "DATABASE_READ_FAILED", "Approval idempotency state could not be read.", correlation);
  }

  try {
    if (body.action === "job.submit") {
      const policy = await env.DB.prepare(
        "SELECT enabled FROM project_operation_policies WHERE tenant_id = ? AND project_id = ? AND operation_id = ?"
      ).bind(principal.tenant_id, principal.project_id, body.operation_id).first();
      if (!policy || policy.enabled !== 1) {
        return errorResponse(403, "OPERATION_NOT_ENABLED", "The requested operation is not enabled for this project.", correlation);
      }
      const quota = await env.DB.prepare(
        "SELECT 1 AS configured FROM project_quotas WHERE tenant_id = ? AND project_id = ?"
      ).bind(principal.tenant_id, principal.project_id).first();
      if (!quota) return errorResponse(403, "QUOTA_NOT_CONFIGURED", "No compute quota is configured for this project.", correlation);
    } else {
      const job = await env.DB.prepare(
        "SELECT state FROM jobs WHERE job_id = ? AND tenant_id = ? AND project_id = ?"
      ).bind(body.target_id, principal.tenant_id, principal.project_id).first();
      if (!job) return errorResponse(404, "JOB_NOT_FOUND", "The requested Job was not found.", correlation);
      if (!CANCELABLE_STATES.has(job.state)) {
        return errorResponse(409, "JOB_NOT_CANCELABLE", "The requested Job is not in a cancellable state.", correlation);
      }
    }
  } catch {
    return errorResponse(503, "DATABASE_READ_FAILED", "Approval policy or target state could not be read.", correlation);
  }

  const approvalId = crypto.randomUUID();
  const createdAt = now;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const eventId = crypto.randomUUID();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO compute_approvals (approval_id, tenant_id, project_id, actor_id, action, operation_id, request_hash, idempotency_key_hash, status, created_at, expires_at, target_id, consumed_at, consumed_by_request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL)"
      ).bind(approvalId, principal.tenant_id, principal.project_id, principal.actor_id, body.action, body.operation_id, body.request_hash, keyHash, createdAt, expiresAt, body.target_id || null),
      env.DB.prepare(
        "INSERT INTO audit_events (event_id, tenant_id, project_id, actor_id, action, resource_id, request_digest, correlation_id, created_at) SELECT ?, ?, ?, ?, 'COMPUTE_APPROVAL_CREATED', ?, ?, ?, ? WHERE changes() = 1"
      ).bind(eventId, principal.tenant_id, principal.project_id, principal.actor_id, approvalId, body.request_hash, correlation, createdAt)
    ]);
    if (results?.[0]?.meta?.changes === 1) {
      return jsonResponse(201, {
        approval_id: approvalId,
        action: body.action,
        operation_id: body.operation_id,
        request_hash: body.request_hash,
        status: "pending",
        created_at: createdAt,
        expires_at: expiresAt,
        ...(body.target_id ? { target_id: body.target_id } : {}),
        replayed: false
      });
    }
    const raced = await findExisting(env, principal, body.action, keyHash);
    if (raced) return existingResponse(raced, body.action, body.operation_id, body.request_hash, body.target_id || null, now, correlation);
    return errorResponse(503, "APPROVAL_CREATE_UNKNOWN", "Approval creation outcome could not be resolved; retry only with the same Idempotency-Key.", correlation);
  } catch {
    return errorResponse(503, "DURABLE_WRITE_FAILED", "Approval could not be durably created.", correlation);
  }
}

export async function consumeApproval(request, env, principal, approvalId, correlation) {
  const dbError = databaseUnavailable(env, correlation);
  if (dbError) return dbError;
  if (!principalHas(principal, "compute:approvals:consume")) {
    return errorResponse(403, "FORBIDDEN", "The principal lacks the approval consumption scope.", correlation);
  }
  if (typeof approvalId !== "string" || !UUID_RE.test(approvalId)) {
    return errorResponse(404, "APPROVAL_NOT_FOUND", "The requested approval was not found.", correlation);
  }
  const parsed = await parseBody(request, correlation);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  if (Object.keys(body).some(key => !["action", "operation_id", "request_hash"].includes(key)) ||
      !ACTIONS.has(body.action) ||
      typeof body.operation_id !== "string" || !OPERATION_RE.test(body.operation_id) ||
      typeof body.request_hash !== "string" || !HASH_RE.test(body.request_hash)) {
    return errorResponse(400, "INVALID_APPROVAL_REQUEST", "Action, operation_id, and a SHA-256 request_hash are required.", correlation);
  }

  const now = new Date().toISOString();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE compute_approvals SET status = 'consumed', consumed_at = ?, consumed_by_request_id = ? WHERE approval_id = ? AND tenant_id = ? AND project_id = ? AND actor_id = ? AND action = ? AND operation_id = ? AND request_hash = ? AND status = 'pending' AND expires_at > ?"
      ).bind(now, correlation, approvalId, principal.tenant_id, principal.project_id, principal.actor_id, body.action, body.operation_id, body.request_hash, now),
      env.DB.prepare(
        "INSERT INTO audit_events (event_id, tenant_id, project_id, actor_id, action, resource_id, request_digest, correlation_id, created_at) SELECT ?, ?, ?, ?, 'COMPUTE_APPROVAL_CONSUMED', ?, ?, ?, ? WHERE changes() = 1"
      ).bind(crypto.randomUUID(), principal.tenant_id, principal.project_id, principal.actor_id, approvalId, body.request_hash, correlation, now)
    ]);
    if (results?.[0]?.meta?.changes === 1) {
      return jsonResponse(200, { approval_id: approvalId, status: "consumed", consumed_at: now, consumed_by_request_id: correlation });
    }
    const existing = await env.DB.prepare(
      "SELECT approval_id, action, operation_id, request_hash, status, expires_at FROM compute_approvals WHERE approval_id = ? AND tenant_id = ? AND project_id = ? AND actor_id = ?"
    ).bind(approvalId, principal.tenant_id, principal.project_id, principal.actor_id).first();
    if (!existing) return errorResponse(404, "APPROVAL_NOT_FOUND", "The requested approval was not found.", correlation);
    if (existing.action !== body.action || existing.operation_id !== body.operation_id || existing.request_hash !== body.request_hash) {
      return errorResponse(409, "APPROVAL_MISMATCH", "Approval does not match this actor, action, operation, or request.", correlation);
    }
    if (existing.status === "consumed") return errorResponse(409, "APPROVAL_ALREADY_CONSUMED", "This approval has already been consumed.", correlation);
    if (existing.status !== "pending" || existing.expires_at <= now) {
      return errorResponse(410, "APPROVAL_EXPIRED", "This approval has expired or is no longer valid.", correlation);
    }
    return errorResponse(409, "APPROVAL_NOT_CONSUMABLE", "Approval could not be consumed in its current state.", correlation);
  } catch {
    return errorResponse(503, "DURABLE_WRITE_FAILED", "Approval consumption could not be durably committed.", correlation);
  }
}
