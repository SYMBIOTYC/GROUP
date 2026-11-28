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


const activationServicePrincipal = {
  kind: "service",
  tenant_id: "tenant-test",
  project_id: "project-test",
  actor_id: "amphetamin-service",
  scopes: ["compute:activation:read", "compute:activation:write"]
};

test("activation state API requires an authenticated service principal", async () => {
  const response = await worker.fetch(new Request("https://group.test/v1/activation/state", {
    headers: trustedHeaders({ ...basePrincipal, scopes: ["compute:activation:read"] })
  }), {});
  const result = await json(response);
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, "SERVICE_PRINCIPAL_REQUIRED");
});

test("activation state API enforces its dedicated read scope", async () => {
  const principal = { ...activationServicePrincipal, scopes: ["compute:activation:write"] };
  const response = await worker.fetch(new Request("https://group.test/v1/activation/state", {
    headers: trustedHeaders(principal)
  }), {});
  const result = await json(response);
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, "FORBIDDEN");
});

test("activation event API rejects client-supplied timestamps and unknown fields", async () => {
  const response = await worker.fetch(new Request("https://group.test/v1/activation/events", {
    method: "POST",
    headers: { ...trustedHeaders(activationServicePrincipal), "content-type": "application/json" },
    body: JSON.stringify({
      event_id: "deployment-0001",
      event_type: "deployment",
      occurred_at: "2000-01-01T00:00:00.000Z"
    })
  }), {});
  const result = await json(response);
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, "INVALID_ACTIVATION_EVENT");
});

test("activation event API requires a configured durable database", async () => {
  const response = await worker.fetch(new Request("https://group.test/v1/activation/events", {
    method: "POST",
    headers: { ...trustedHeaders(activationServicePrincipal), "content-type": "application/json" },
    body: JSON.stringify({ event_id: "deployment-0001", event_type: "deployment" })
  }), {});
  const result = await json(response);
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "DATABASE_UNAVAILABLE");
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


test("capabilities endpoint requires the trusted AMPHETAMIN principal", async () => {
  const response = await worker.fetch(new Request("https://group.test/v1/capabilities"));
  const result = await json(response);
  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, "INTERNAL_GATEWAY_REQUIRED");
});

test("capabilities endpoint requires compute:jobs:read", async () => {
  const principal = { ...basePrincipal, scopes: ["compute:jobs:write"] };
  const response = await worker.fetch(new Request("https://group.test/v1/capabilities", {
    headers: trustedHeaders(principal)
  }), {});
  const result = await json(response);
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, "FORBIDDEN");
});

test("capabilities endpoint reports no enabled operations and keeps dispatch disabled", async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      calls.push(sql);
      return {
        bind(...values) {
          assert.deepEqual(values, ["tenant-test", "project-test"]);
          return {
            first: async () => ({ max_active_jobs: 3, max_cpu_millis_per_job: 1000 }),
            all: async () => ({ results: [] })
          };
        }
      };
    },
    batch: async () => { throw new Error("capabilities must be read-only"); }
  };
  const response = await worker.fetch(new Request("https://group.test/v1/capabilities", {
    headers: trustedHeaders()
  }), { DB: db });
  const result = await json(response);
  assert.equal(result.status, 200);
  assert.equal(result.body.protocol, "symbiotyc.compute.v1");
  assert.equal(result.body.dispatch_enabled, false);
  assert.equal(result.body.job_submission_enabled, false);
  assert.deepEqual(result.body.enabled_operations, []);
  assert.equal(calls.length, 2);
});


const tenantBJob = {
  job_id: "b5d6b8c6-79ec-4e45-86e7-5c9f0e36d0ad",
  tenant_id: "tenant-b",
  project_id: "project-b",
  operation_id: "image.thumbnail",
  state: "QUEUED",
  record_version: 1,
  created_at: "2026-11-28T00:00:00Z",
  updated_at: "2026-11-28T00:00:00Z",
  deadline_at: null,
  correlation_id: "tenant-b-correlation"
};

const tenantAPrincipal = {
  ...basePrincipal,
  tenant_id: "tenant-a",
  project_id: "project-a"
};

test("Tenant A cannot read Tenant B Job by its known UUID", async () => {
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            first: async () => {
              assert.match(sql, /WHERE job_id = \? AND tenant_id = \? AND project_id = \?/);
              assert.deepEqual(values, [tenantBJob.job_id, "tenant-a", "project-a"]);
              return values[1] === tenantBJob.tenant_id && values[2] === tenantBJob.project_id
                ? tenantBJob
                : null;
            }
          };
        }
      };
    },
    async batch() { return []; }
  };

  const response = await worker.fetch(new Request(`https://group.test/v1/jobs/${tenantBJob.job_id}`, {
    headers: trustedHeaders(tenantAPrincipal)
  }), { DB: db });
  const result = await json(response);

  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, "JOB_NOT_FOUND");
  assert.equal(JSON.stringify(result.body).includes("tenant-b-correlation"), false);
});

test("Tenant A cannot cancel Tenant B Job or create audit/outbox side effects", async () => {
  let batchStatements = [];
  const db = {
    prepare(sql) {
      return {
        sql,
        bind(...values) {
          return {
            sql,
            values,
            first: async () => {
              assert.match(sql, /WHERE job_id = \? AND tenant_id = \? AND project_id = \?/);
              assert.deepEqual(values, [tenantBJob.job_id, "tenant-a", "project-a"]);
              return null;
            }
          };
        }
      };
    },
    async batch(statements) {
      batchStatements = statements;
      const update = statements[0];
      assert.match(update.sql, /WHERE job_id = \? AND tenant_id = \? AND project_id = \?/);
      assert.equal(update.values[1], tenantBJob.job_id);
      assert.deepEqual(update.values.slice(2), ["tenant-a", "project-a"]);
      assert.match(statements[1].sql, /FROM jobs WHERE job_id = \? AND changes\(\) = 1/);
      assert.match(statements[2].sql, /FROM jobs WHERE job_id = \? AND changes\(\) = 1/);
      // The tenant-scoped UPDATE affects zero rows. SQLite's changes() guard
      // therefore prevents the audit and outbox INSERT...SELECT statements.
      return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }, { meta: { changes: 0 } }];
    }
  };

  const response = await worker.fetch(new Request(`https://group.test/v1/jobs/${tenantBJob.job_id}/cancel`, {
    method: "POST",
    headers: trustedHeaders(tenantAPrincipal)
  }), { DB: db });
  const result = await json(response);

  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, "JOB_NOT_FOUND");
  assert.equal(batchStatements.length, 3);
});

test("Tenant A cannot replay Tenant B idempotency record", async () => {
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            first: async () => {
              if (sql.includes("FROM idempotency_records")) {
                assert.match(sql, /WHERE tenant_id = \? AND project_id = \? AND operation_id = \? AND idempotency_key_hash = \?/);
                assert.deepEqual(values.slice(0, 2), ["tenant-a", "project-a"]);
                // The synthetic Tenant B row must not match Tenant A's scoped lookup.
                return values[0] === "tenant-b" && values[1] === "project-b"
                  ? { request_hash: "a".repeat(64), job_id: tenantBJob.job_id }
                  : null;
              }
              if (sql.includes("FROM project_operation_policies")) {
                assert.deepEqual(values.slice(0, 2), ["tenant-a", "project-a"]);
                return null;
              }
              if (sql.includes("FROM project_quotas")) {
                assert.deepEqual(values, ["tenant-a", "project-a"]);
                return null;
              }
              throw new Error("Unexpected query in cross-tenant idempotency test");
            }
          };
        }
      };
    },
    async batch() { return []; }
  };

  const response = await worker.fetch(new Request("https://group.test/v1/jobs", {
    method: "POST",
    headers: {
      ...trustedHeaders(tenantAPrincipal),
      "idempotency-key": "tenant-b-key-0001",
      "content-type": "application/json"
    },
    body: JSON.stringify(validIntent())
  }), { DB: db });
  const result = await json(response);

  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, "OPERATION_NOT_ALLOWED");
  assert.equal(JSON.stringify(result.body).includes(tenantBJob.job_id), false);
});

test("Tenant A activation evaluation hydrates only Tenant A project state", async () => {
  const tenantBState = {
    activation_remaining_minutes: 540,
    deployment_streak: 5,
    burnout_score: 90,
    recovery_remainder_minutes: 0,
    updated_at: "2026-11-28T10:00:00.000Z",
    version: 17
  };
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            first: async () => {
              assert.match(sql, /FROM amphetamin_activation_state WHERE tenant_id = \? AND project_id = \?/);
              assert.deepEqual(values, ["tenant-a", "project-a"]);
              // A Tenant B row exists, but cannot satisfy Tenant A's composite key.
              return values[0] === "tenant-b" && values[1] === "project-b"
                ? tenantBState
                : null;
            }
          };
        }
      };
    },
    async batch() { return []; }
  };
  const evaluator = input => ({
    mode: 0,
    worker_count: 0,
    activation_remaining_minutes: input.activation_remaining_minutes,
    drive_multiplier_percent: 100,
    projected_burnout_score: input.burnout_score
  });
  const telemetry = {
    backlog: 0,
    ambiguous_tasks: 0,
    resource_pressure: 0,
    overload_score: 0,
    quality_score: 100,
    cooldown_latched: 0,
    recovery_score: 100,
    integrity_risk: 0,
    available_credits: 10,
    max_credits: 10,
    max_workers: 1
  };

  const response = await worker.fetch(new Request("https://group.test/v1/activation/evaluate", {
    method: "POST",
    headers: {
      ...trustedHeaders({
        ...activationServicePrincipal,
        tenant_id: "tenant-a",
        project_id: "project-a",
        scopes: ["compute:activation:evaluate"]
      }),
      "content-type": "application/json"
    },
    body: JSON.stringify(telemetry)
  }), { DB: db, AMPHETAMIN_EVALUATOR: evaluator });
  const result = await json(response);

  assert.equal(result.status, 200);
  assert.equal(result.body.activation_state.activation_remaining_minutes, 0);
  assert.equal(result.body.activation_state.deployment_streak, 0);
  assert.equal(result.body.activation_state.burnout_score, 0);
  assert.equal(result.body.activation_state.version, 0);
  assert.notEqual(result.body.activation_state.version, tenantBState.version);
});
