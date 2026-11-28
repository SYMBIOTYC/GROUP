const LOOKUP_SQL = `
  SELECT
    w.worker_id,
    w.tenant_id,
    w.project_id,
    w.state AS worker_state,
    w.registration_epoch,
    c.token_jti,
    c.signing_key_id,
    c.expires_at AS credential_expires_at,
    c.revoked_at
  FROM worker_credentials AS c
  INNER JOIN workers AS w ON w.worker_id = c.worker_id
  WHERE w.worker_id = ?
    AND c.token_jti = ?
    AND c.registration_epoch = ?
    AND c.signing_key_id = ?
    AND c.revoked_at IS NULL
    AND julianday(c.expires_at) > julianday(?)
    AND w.registration_epoch = c.registration_epoch
    AND w.state IN ('ACTIVE', 'DEGRADED')
  LIMIT 1
`;

function validateIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new TypeError("Worker credential identity is required");
  }
  const expectedKeys = ["jti", "keyId", "registrationEpoch", "workerId"];
  const keys = Object.keys(identity).sort();
  if (keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError("Worker credential identity contains unsupported fields");
  }
  for (const field of ["workerId", "jti", "keyId"]) {
    if (typeof identity[field] !== "string" || identity[field].length < 1 || identity[field].length > 256) {
      throw new TypeError(`Worker credential identity has invalid ${field}`);
    }
  }
  if (!Number.isSafeInteger(identity.registrationEpoch) || identity.registrationEpoch < 1) {
    throw new TypeError("Worker credential identity has invalid registrationEpoch");
  }
}

/**
 * Create a fail-closed D1 resolver for the Worker JWT verifier.
 * Tenant and project scope are returned only from the joined server-side rows;
 * they are never accepted as lookup inputs.
 */
export function createD1WorkerCredentialResolver({ db, now = () => new Date() } = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("A D1 database binding is required");
  }
  if (typeof now !== "function") {
    throw new TypeError("Resolver clock must be a function");
  }

  return async function resolveWorkerCredential(identity) {
    validateIdentity(identity);
    const instant = now();
    const nowMs = instant instanceof Date ? instant.getTime() : NaN;
    if (!Number.isFinite(nowMs)) throw new TypeError("Resolver clock returned an invalid time");
    const nowIso = new Date(nowMs).toISOString();

    const row = await db.prepare(LOOKUP_SQL).bind(
      identity.workerId,
      identity.jti,
      identity.registrationEpoch,
      identity.keyId,
      nowIso
    ).first();

    if (!row || (row.worker_state !== "ACTIVE" && row.worker_state !== "DEGRADED")) return null;
    if (row.worker_id !== identity.workerId ||
        row.token_jti !== identity.jti ||
        row.registration_epoch !== identity.registrationEpoch ||
        row.signing_key_id !== identity.keyId ||
        row.revoked_at !== null ||
        typeof row.tenant_id !== "string" || !row.tenant_id ||
        typeof row.project_id !== "string" || !row.project_id) {
      return null;
    }

    const credentialExpiry = Date.parse(row.credential_expires_at);
    if (!Number.isFinite(credentialExpiry) || credentialExpiry <= nowMs) return null;

    return {
      active: true,
      workerId: row.worker_id,
      jti: row.token_jti,
      registrationEpoch: row.registration_epoch,
      keyId: row.signing_key_id,
      tenantId: row.tenant_id,
      projectId: row.project_id
    };
  };
}
