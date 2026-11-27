import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";

const json = async (response) => ({ status: response.status, body: await response.json() });

test("health endpoint is read-only and explicitly reports dispatch disabled", async () => {
  const response = await worker.fetch(new Request("https://group.test/health"));
  const result = await json(response);
  assert.equal(result.status, 200);
  assert.equal(result.body.service, "symbiotyc-group-control-plane");
  assert.equal(result.body.dispatch_enabled, false);
});

test("protected Job API rejects unauthenticated requests", async () => {
  const response = await worker.fetch(new Request("https://group.test/v1/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  }), {});
  const result = await json(response);
  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("protected Job API fails closed when identity service binding is missing", async () => {
  const response = await worker.fetch(new Request("https://group.test/v1/jobs", {
    method: "POST",
    headers: { authorization: "Bearer opaque-test-token", "content-type": "application/json" },
    body: JSON.stringify({})
  }), {});
  const result = await json(response);
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "IDENTITY_PROVIDER_UNAVAILABLE");
});

test("Job API never acknowledges acceptance when durable database binding is missing", async () => {
  const authService = {
    fetch: async () => new Response(JSON.stringify({
      ok: true,
      principal: {
        kind: "user",
        tenant_id: "tenant-test",
        project_id: "project-test",
        actor_id: "actor-test",
        scopes: ["compute:jobs:write"]
      }
    }), { status: 200, headers: { "content-type": "application/json" } })
  };
  const response = await worker.fetch(new Request("https://group.test/v1/jobs", {
    method: "POST",
    headers: {
      authorization: "Bearer opaque-test-token",
      "idempotency-key": "intent-0123456789",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      protocol: "symbiotyc.compute.v1",
      schema_version: "1.0",
      operation_id: "image.thumbnail",
      input: { artifact_refs: ["artifact:opaque-1"], parameters: {} },
      constraints: {},
      output_policy: { format: "json", max_bytes: 1024 }
    })
  }), { AUTH_SERVICE: authService });
  const result = await json(response);
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "DATABASE_UNAVAILABLE");
});
