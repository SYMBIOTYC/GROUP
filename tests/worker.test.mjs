import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { canonicalJson, sha256Hex, validateJobIntent } from "../src/job-intent.mjs";

const json = async (response) => ({ status: response.status, body: await response.json() });
const basePrincipal = {
  kind: "user",
  tenant_id: "tenant-test",
  project_id: "project-test",
  actor_id: "actor-test",
  scopes: ["compute:jobs:write", "compute:jobs:read", "compute:jobs:cancel"]
};
const trustedHeaders = (principal = basePrincipal, caller = "amphetamin") => ({
  "x-symbiotyc-caller": caller,
  "x-symbiotyc-principal": Buffer.from(JSON.stringify(principal)).toString("base64url")
});
const validIntent = () => ({
  protocol: "symbiotyc.compute.v1",
  schema_version: "1.0",
  operation_id: "image.thumbnail",
  input: { artifact_refs: ["artifact:opaque-1"], parameters: {} },
  constraints: {},
  output_policy: { format: "json", max_bytes: 1024 }
});

test("health endpoint is read-only and explicitly reports dispatch disabled", async () => {
  const response = await worker.fetch(new Request("https://group.test/health"));
  const result = await json(response);
  assert.equal(result.status, 200);
  assert.equal(result.body.service, "symbiotyc-group-control-plane");
  assert.equal(result.body.dispatch_enabled, false);
});

test("protected Job API rejects requests without the internal gateway marker", async () => {
  const response = await worker.fetch(new Request("https://group.test/v1/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  }), {});
  const result = await json(response);
  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, "INTERNAL_GATEWAY_REQUIRED");
});

test("protected Job API rejects an unexpected service-binding caller", async () => {
  const response = await worker.fetch(new Request("https://group.test/v1/jobs", {
    method: "POST",
    headers: { ...trustedHeaders(basePrincipal, "untrusted-worker"), "content-type": "application/json" },
    body: JSON.stringify({})
  }), {});
  const result = await json(response);
  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, "INTERNAL_GATEWAY_REQUIRED");
});

test("protected Job API rejects malformed trusted-principal assertions", async () => {
  const headers = { "x-symbiotyc-caller": "amphetamin", "x-symbiotyc-principal": "not-base64-json", "content-type": "application/json" };
  const response = await worker.fetch(new Request("https://group.test/v1/jobs", {
    method: "POST", headers, body: JSON.stringify({})
  }), {});
  const result = await json(response);
  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, "INVALID_TRUSTED_PRINCIPAL");
});

test("protected Job API enforces the scope in the trusted principal", async () => {
  const principal = { ...basePrincipal, scopes: ["compute:jobs:read"] };
  const response = await worker.fetch(new Request("https://group.test/v1/jobs", {
    method: "POST",
    headers: { ...trustedHeaders(principal), "content-type": "application/json" },
    body: JSON.stringify(validIntent())
  }), {});
  const result = await json(response);
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, "FORBIDDEN");
});

test("Job API never acknowledges acceptance when durable database binding is missing", async () => {
  const response = await worker.fetch(new Request("https://group.test/v1/jobs", {
    method: "POST",
    headers: {
      ...trustedHeaders(),
      "idempotency-key": "intent-0123456789",
      "content-type": "application/json"
    },
    body: JSON.stringify(validIntent())
  }), {});
  const result = await json(response);
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "DATABASE_UNAVAILABLE");
});

test("idempotent replay returns the original Job without quota or policy checks", async () => {
  const intent = validIntent();
  const normalized = validateJobIntent(intent).value;
  const requestHash = await sha256Hex(canonicalJson(normalized));
  const jobId = "b5d6b8c6-79ec-4e45-86e7-5c9f0e36d0ad";
  const row = {
    job_id: jobId, operation_id: "image.thumbnail", state: "QUEUED",
    record_version: 1, created_at: "2026-11-28T00:00:00Z",
    updated_at: "2026-11-28T00:00:00Z", deadline_at: null, correlation_id: "corr-existing"
  };
  const db = {
    prepare(sql) {
      return { bind() { return { first: async () => {
        if (sql.includes("FROM idempotency_records")) return { request_hash: requestHash, job_id: jobId };
        if (sql.includes("FROM jobs")) return row;
        throw new Error("Unexpected query during idempotency replay");
      } }; } };
    },
    batch: async () => { throw new Error("Replay must not reserve quota or create a new Job"); }
  };
  const response = await worker.fetch(new Request("https://group.test/v1/jobs", {
    method: "POST",
    headers: { ...trustedHeaders(), "idempotency-key": "intent-0123456789", "content-type": "application/json" },
    body: JSON.stringify(intent)
  }), { DB: db });
  const result = await json(response);
  assert.equal(result.status, 202);
  assert.equal(result.body.job_id, jobId);
  assert.equal(result.body.replayed, true);
});

test("idempotency conflict is returned before policy or quota evaluation", async () => {
  const db = {
    prepare(sql) {
      return { bind() { return { first: async () => {
        if (sql.includes("FROM idempotency_records")) return { request_hash: "f".repeat(64), job_id: "existing-job" };
        throw new Error("Policy must not be read for a conflicting idempotency key");
      } }; } };
    },
    batch: async () => { throw new Error("Conflicting request must not write"); }
  };
  const response = await worker.fetch(new Request("https://group.test/v1/jobs", {
    method: "POST",
    headers: { ...trustedHeaders(), "idempotency-key": "intent-0123456789", "content-type": "application/json" },
    body: JSON.stringify(validIntent())
  }), { DB: db });
  const result = await json(response);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "IDEMPOTENCY_CONFLICT");
});
