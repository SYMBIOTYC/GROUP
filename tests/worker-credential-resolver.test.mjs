import test from "node:test";
import assert from "node:assert/strict";
import { createD1WorkerCredentialResolver } from "../src/worker-credential-resolver.mjs";

const identity = {
  workerId: "worker-123",
  jti: "credential-jti-001",
  registrationEpoch: 7,
  keyId: "group-2026-01"
};
const now = new Date("2026-11-28T12:00:00.000Z");
const validRow = {
  worker_id: "worker-123",
  tenant_id: "tenant-a",
  project_id: "project-a",
  worker_state: "ACTIVE",
  registration_epoch: 7,
  token_jti: "credential-jti-001",
  signing_key_id: "group-2026-01",
  credential_expires_at: "2026-11-28T12:05:00.000Z",
  revoked_at: null,
  worker_revoked_at: null
};

function d1Returning(row) {
  let statement = "";
  let parameters = [];
  return {
    db: {
      prepare(sql) {
        statement = sql;
        return {
          bind(...values) {
            parameters = values;
            return { first: async () => row };
          }
        };
      }
    },
    get statement() { return statement; },
    get parameters() { return parameters; }
  };
}

test("resolves an active credential and returns tenant/project from D1", async () => {
  const fake = d1Returning(validRow);
  const resolve = createD1WorkerCredentialResolver({ db: fake.db, now: () => now });
  const result = await resolve(identity);
  assert.deepEqual(result, {
    active: true,
    workerId: "worker-123",
    jti: "credential-jti-001",
    registrationEpoch: 7,
    keyId: "group-2026-01",
    tenantId: "tenant-a",
    projectId: "project-a"
  });
  assert.deepEqual(fake.parameters, ["worker-123", "credential-jti-001", 7, "group-2026-01", now.toISOString()]);
});

test("queries by server-issued worker subject and exact credential identity", async () => {
  const fake = d1Returning(validRow);
  const resolve = createD1WorkerCredentialResolver({ db: fake.db, now: () => now });
  await resolve(identity);
  for (const fragment of [
    "JOIN workers", "w.worker_id = c.worker_id", "c.token_jti = ?",
    "c.registration_epoch = ?", "c.signing_key_id = ?", "c.revoked_at IS NULL",
    "julianday(c.expires_at) > julianday(?)", "w.state IN ('ACTIVE', 'DEGRADED')", "w.revoked_at IS NULL",
    "w.tenant_id", "w.project_id"
  ]) assert.ok(fake.statement.includes(fragment), `missing SQL guard: ${fragment}`);
});

test("returns null for an unknown worker or credential", async () => {
  const resolve = createD1WorkerCredentialResolver({ db: d1Returning(null).db, now: () => now });
  assert.equal(await resolve(identity), null);
});

test("fails closed for invalid resolver identity", async () => {
  const fake = d1Returning(validRow);
  const resolve = createD1WorkerCredentialResolver({ db: fake.db, now: () => now });
  await assert.rejects(resolve({ ...identity, tenantId: "caller-tenant" }), /identity/i);
  await assert.rejects(resolve({ ...identity, registrationEpoch: 0 }), /identity/i);
});

test("rejects revoked, expired, or non-eligible Worker rows even if returned by D1", async () => {
  const invalidRows = [
    { ...validRow, revoked_at: "2026-11-28T11:59:00.000Z" },
    { ...validRow, credential_expires_at: "2026-11-28T12:00:00.000Z" },
    { ...validRow, worker_state: "DRAINING" },
    { ...validRow, worker_revoked_at: "2026-11-28T11:59:00.000Z" }
  ];
  for (const row of invalidRows) {
    const resolve = createD1WorkerCredentialResolver({ db: d1Returning(row).db, now: () => now });
    assert.equal(await resolve(identity), null);
  }
});

test("rejects mismatched worker, epoch, JTI, or signing key returned by D1", async () => {
  const invalidRows = [
    { ...validRow, worker_id: "other-worker" },
    { ...validRow, registration_epoch: 8 },
    { ...validRow, token_jti: "other-jti" },
    { ...validRow, signing_key_id: "other-key" }
  ];
  for (const row of invalidRows) {
    const resolve = createD1WorkerCredentialResolver({ db: d1Returning(row).db, now: () => now });
    assert.equal(await resolve(identity), null);
  }
});

test("requires a D1 database binding", () => {
  assert.throws(() => createD1WorkerCredentialResolver({}), /D1/i);
});

test("fails closed when the D1 lookup throws", async () => {
  const db = { prepare() { throw new Error("database unavailable"); } };
  const resolve = createD1WorkerCredentialResolver({ db, now: () => now });
  await assert.rejects(resolve(identity), /database unavailable/);
});
