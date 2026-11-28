import test from "node:test";
import assert from "node:assert/strict";
import { createApproval, consumeApproval } from "../src/approvals.mjs";

const principal = {
  kind: "user",
  tenant_id: "symbiotyc",
  project_id: "compute",
  actor_id: "access:owner-hash",
  scopes: ["compute:approvals:write", "compute:approvals:consume"]
};
const submit = {
  action: "job.submit",
  operation_id: "image.thumbnail",
  request_hash: "a".repeat(64),
  ttl_seconds: 120
};
const request = (body, key = "approval-create-0001") => new Request("https://group.internal/v1/approvals", {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": key },
  body: JSON.stringify(body)
});
const consumeRequest = body => new Request("https://group.internal/v1/approvals/00000000-0000-4000-8000-000000000001/consume", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});

class MemoryApprovalDB {
  constructor() {
    this.rows = new Map();
    this.audit = [];
    this.policies = new Map([["symbiotyc:compute:image.thumbnail", { enabled: 1 }]]);
    this.quotas = new Map([["symbiotyc:compute", { tenant_id: "symbiotyc", project_id: "compute" }]]);
    this.jobs = new Map();
    this.lastChanges = 0;
  }
  prepare(sql) {
    const db = this;
    const statement = {
      sql, values: [],
      bind(...values) { this.values = values; return this; },
      async first() { return db.first(sql, this.values); },
      async run() { return db.run(sql, this.values, db.lastChanges); }
    };
    return statement;
  }
  async batch(statements) {
    const results = [];
    let previousChanges = 0;
    for (const statement of statements) {
      const result = await this.run(statement.sql, statement.values, previousChanges);
      previousChanges = result.meta?.changes ?? 0;
      results.push(result);
    }
    this.lastChanges = previousChanges;
    return results;
  }
  async first(sql, values) {
    if (sql.includes("FROM project_operation_policies")) return this.policies.get(values.join(":")) ?? null;
    if (sql.includes("FROM project_quotas")) return this.quotas.get(values.join(":")) ?? null;
    if (sql.includes("FROM jobs")) return this.jobs.get(values[0]) ?? null;
    if (sql.includes("FROM compute_approvals") && sql.includes("idempotency_key_hash")) {
      const [tenant, project, actor, action, keyHash] = values;
      return [...this.rows.values()].find(row => row.tenant_id === tenant && row.project_id === project && row.actor_id === actor && row.action === action && row.idempotency_key_hash === keyHash) ?? null;
    }
    if (sql.includes("FROM compute_approvals") && sql.includes("approval_id")) {
      const [approvalId, tenant, project, actor] = values;
      const row = this.rows.get(approvalId);
      return row && row.tenant_id === tenant && row.project_id === project && row.actor_id === actor ? row : null;
    }
    throw new Error("Unsupported fake D1 first() query: " + sql);
  }
  async run(sql, values, previousChanges = 0) {
    if (sql.includes("INSERT OR IGNORE INTO compute_approvals")) {
      const [id, tenant, project, actor, action, operation, requestHash, keyHash, createdAt, expiresAt, targetId] = values;
      const unique = [tenant, project, actor, action, keyHash].join(":");
      const exists = [...this.rows.values()].some(row => [row.tenant_id,row.project_id,row.actor_id,row.action,row.idempotency_key_hash].join(":") === unique);
      if (exists) return { success: true, meta: { changes: 0 } };
      this.rows.set(id, { approval_id:id, tenant_id:tenant, project_id:project, actor_id:actor, action, operation_id:operation, request_hash:requestHash, idempotency_key_hash:keyHash, status:"pending", created_at:createdAt, expires_at:expiresAt, target_id:targetId, consumed_at:null, consumed_by_request_id:null });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE compute_approvals")) {
      const [consumedAt, requestId, approvalId, tenant, project, actor, action, operation, requestHash, now] = values;
      const row = this.rows.get(approvalId);
      if (!row || row.tenant_id!==tenant || row.project_id!==project || row.actor_id!==actor || row.action!==action || row.operation_id!==operation || row.request_hash!==requestHash || row.status!=="pending" || row.expires_at<=now) return { success:true, meta:{changes:0} };
      row.status="consumed"; row.consumed_at=consumedAt; row.consumed_by_request_id=requestId;
      return { success:true, meta:{changes:1} };
    }
    if (sql.includes("INSERT INTO audit_events") && sql.includes("SELECT")) {
      if (previousChanges===1) this.audit.push({values,action:sql.includes("COMPUTE_APPROVAL_CREATED") ? "COMPUTE_APPROVAL_CREATED" : "COMPUTE_APPROVAL_CONSUMED",resource_id:values[4]});
      return {success:true,meta:{changes:previousChanges===1?1:0}};
    }
    throw new Error("Unsupported fake D1 run() query: " + sql);
  }
}

test("creates a short-lived approval bound to tenant, project, actor, action and request hash", async () => {
  const DB = new MemoryApprovalDB();
  const response = await createApproval(request(submit), { DB }, principal, "corr-create-1");
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.status, "pending");
  assert.equal(body.action, "job.submit");
  assert.equal(body.operation_id, "image.thumbnail");
  assert.equal(body.request_hash, submit.request_hash);
  assert.equal(body.expires_at > body.created_at, true);
  assert.equal(DB.rows.size, 1);
  assert.equal(DB.audit[0].action, "COMPUTE_APPROVAL_CREATED");
});

test("replays the same approval for the same idempotency key and rejects a payload conflict", async () => {
  const DB = new MemoryApprovalDB();
  const first = await createApproval(request(submit), { DB }, principal, "corr-create-1");
  const firstBody = await first.json();
  const replay = await createApproval(request(submit), { DB }, principal, "corr-create-2");
  const replayBody = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(replayBody.approval_id, firstBody.approval_id);
  assert.equal(replayBody.replayed, true);
  const conflict = await createApproval(request({ ...submit, request_hash: "b".repeat(64) }), { DB }, principal, "corr-create-3");
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "APPROVAL_IDEMPOTENCY_CONFLICT");
});

test("refuses submit approvals when quota or operation policy is not enabled", async () => {
  const DB = new MemoryApprovalDB();
  DB.policies.clear();
  const response = await createApproval(request(submit), { DB }, principal, "corr-create-1");
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "OPERATION_NOT_ENABLED");
  assert.equal(DB.rows.size, 0);
});

test("requires an existing non-terminal tenant/project job before approving cancellation", async () => {
  const DB = new MemoryApprovalDB();
  const body = { action:"job.cancel", operation_id:"job.cancel", request_hash:"c".repeat(64), target_id:"2b8c2d6f-2f1d-4e8c-9d1c-9a8f3e5b7c10" };
  const missing = await createApproval(request(body), { DB }, principal, "corr-cancel-1");
  assert.equal(missing.status, 404);
  DB.jobs.set(body.target_id, { job_id:body.target_id, state:"QUEUED" });
  const created = await createApproval(request(body, "approval-cancel-0001"), { DB }, principal, "corr-cancel-2");
  assert.equal(created.status, 201);
});

test("consumes a matching approval exactly once and appends a consume audit event", async () => {
  const DB = new MemoryApprovalDB();
  const created = await createApproval(request(submit), { DB }, principal, "corr-create-1");
  const approvalId = (await created.json()).approval_id;
  const response = await consumeApproval(consumeRequest({ action:submit.action, operation_id:submit.operation_id, request_hash:submit.request_hash }), { DB }, principal, approvalId, "corr-submit-1");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "consumed");
  assert.equal(DB.rows.get(approvalId).status, "consumed");
  assert.equal(DB.audit.at(-1).action, "COMPUTE_APPROVAL_CONSUMED");
  const replay = await consumeApproval(consumeRequest({ action:submit.action, operation_id:submit.operation_id, request_hash:submit.request_hash }), { DB }, principal, approvalId, "corr-submit-2");
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error.code, "APPROVAL_ALREADY_CONSUMED");
});

test("cannot consume approval with a different actor, tenant, project, operation or request hash", async () => {
  const DB = new MemoryApprovalDB();
  const created = await createApproval(request(submit), { DB }, principal, "corr-create-1");
  const approvalId = (await created.json()).approval_id;
  const wrongPrincipal = { ...principal, actor_id:"access:other-actor" };
  const wrongActor = await consumeApproval(consumeRequest({ action:submit.action, operation_id:submit.operation_id, request_hash:submit.request_hash }), { DB }, wrongPrincipal, approvalId, "corr-1");
  assert.equal(wrongActor.status, 404);
  const wrongTenant = await consumeApproval(consumeRequest({ action:submit.action, operation_id:submit.operation_id, request_hash:submit.request_hash }), { DB }, { ...principal, tenant_id:"other-tenant" }, approvalId, "corr-tenant");
  assert.equal(wrongTenant.status, 404);
  const wrongProject = await consumeApproval(consumeRequest({ action:submit.action, operation_id:submit.operation_id, request_hash:submit.request_hash }), { DB }, { ...principal, project_id:"other-project" }, approvalId, "corr-project");
  assert.equal(wrongProject.status, 404);
  const wrongHash = await consumeApproval(consumeRequest({ action:submit.action, operation_id:submit.operation_id, request_hash:"d".repeat(64) }), { DB }, principal, approvalId, "corr-2");
  assert.equal(wrongHash.status, 409);
  assert.equal((await wrongHash.json()).error.code, "APPROVAL_MISMATCH");
});

test("expired approvals cannot be consumed", async () => {
  const DB = new MemoryApprovalDB();
  const approvalId="00000000-0000-4000-8000-000000000001";
  DB.rows.set(approvalId,{approval_id:approvalId,tenant_id:principal.tenant_id,project_id:principal.project_id,actor_id:principal.actor_id,action:submit.action,operation_id:submit.operation_id,request_hash:submit.request_hash,status:"pending",expires_at:"2000-01-01T00:00:00.000Z"});
  const response = await consumeApproval(consumeRequest({ action:submit.action, operation_id:submit.operation_id, request_hash:submit.request_hash }), { DB }, principal, approvalId, "corr-expired");
  assert.equal(response.status, 410);
  assert.equal((await response.json()).error.code, "APPROVAL_EXPIRED");
});

test("rejects invalid hashes and excessive approval TTL", async () => {
  const DB = new MemoryApprovalDB();
  const invalidHash = await createApproval(request({ ...submit, request_hash:"not-a-hash" }), { DB }, principal, "corr-invalid");
  assert.equal(invalidHash.status, 400);
  const excessive = await createApproval(request({ ...submit, ttl_seconds:3600 }, "approval-create-0002"), { DB }, principal, "corr-ttl");
  assert.equal(excessive.status, 400);
});

test("fails closed when the approval database is unavailable", async () => {
  const response = await createApproval(request(submit), {}, principal, "corr-no-db");
  assert.equal(response.status, 503);
});
