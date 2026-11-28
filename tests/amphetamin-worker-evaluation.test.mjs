import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";

const servicePrincipal = {
  kind: "service",
  tenant_id: "tenant-wasm",
  project_id: "project-wasm",
  actor_id: "amphetamin-service",
  scopes: ["compute:activation:evaluate"]
};
const headers = {
  "content-type": "application/json",
  "x-symbiotyc-caller": "amphetamin",
  "x-symbiotyc-principal": Buffer.from(JSON.stringify(servicePrincipal)).toString("base64url")
};
const telemetry = {
  backlog: 3,
  ambiguous_tasks: 0,
  resource_pressure: 0,
  overload_score: 0,
  quality_score: 100,
  cooldown_latched: 0,
  recovery_score: 0,
  integrity_risk: 0,
  available_credits: 10,
  max_credits: 10,
  max_workers: 4
};
const db = {
  prepare() {
    return { bind() { return { first: async () => null }; } };
  }
};

test("activation evaluation route uses the configured evaluator and server-generated CSPRNG input", async () => {
  let captured;
  const response = await worker.fetch(new Request("https://group.test/v1/activation/evaluate", {
    method: "POST",
    headers,
    body: JSON.stringify(telemetry)
  }), {
    DB: db,
    AMPHETAMIN_EVALUATOR: input => {
      captured = input;
      return {
        mode: 1, worker_count: 1, request_refill: 0, request_capacity: 0,
        reason_code: 5, activation_remaining_minutes: 0,
        drive_multiplier_percent: 100, projected_burnout_score: 0
      };
    }
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.decision.mode, 1);
  assert.equal(result.activation_state.version, 0);
  assert.ok(Number.isInteger(captured.random_u32));
  assert.ok(captured.random_u32 >= 0 && captured.random_u32 <= 0xffffffff);
  assert.equal(captured.backlog, 3);
  assert.equal(captured.quality_score, 100);
});

test("activation evaluation route rejects caller-supplied random values and unknown telemetry", async () => {
  const response = await worker.fetch(new Request("https://group.test/v1/activation/evaluate", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...telemetry, random_u32: 0 })
  }), { DB: db, AMPHETAMIN_EVALUATOR: () => ({}) });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "INVALID_POLICY_INPUT");
});

test("activation evaluation route fails closed when the WASM evaluator is not bound", async () => {
  const response = await worker.fetch(new Request("https://group.test/v1/activation/evaluate", {
    method: "POST",
    headers,
    body: JSON.stringify(telemetry)
  }), { DB: db });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "POLICY_RUNTIME_UNAVAILABLE");
});
