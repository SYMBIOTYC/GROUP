import test from "node:test";
import assert from "node:assert/strict";
import { validateJobIntent, canonicalJson, sha256Hex } from "../src/job-intent.mjs";

const validIntent = () => ({
  protocol: "symbiotyc.compute.v1",
  schema_version: "1.0",
  operation_id: "image.thumbnail",
  input: {
    artifact_refs: ["artifact:opaque-123"],
    parameters: { width: 128, height: 128 }
  },
  constraints: {
    worker_pool: "CLOUD-CPU",
    required_capabilities: ["image-processing"],
    cpu_millis: 1000,
    memory_mib: 512,
    ephemeral_disk_mib: 512,
    timeout_seconds: 120,
    max_attempts: 2
  },
  output_policy: { format: "json", max_bytes: 1048576 }
});

test("accepts a bounded data-only JobIntent", () => {
  const result = validateJobIntent(validIntent());
  assert.equal(result.ok, true);
  assert.equal(result.value.operation_id, "image.thumbnail");
  assert.equal(result.value.constraints.max_attempts, 2);
});

test("rejects caller-supplied tenant and actor identity", () => {
  const intent = validIntent();
  intent.tenant_id = "attacker-tenant";
  intent.actor_id = "attacker-actor";
  assert.equal(validateJobIntent(intent).ok, false);
});

test("rejects secret-like input fields before persisting input", () => {
  const intent = validIntent();
  intent.input.parameters.api_token = "do-not-store";
  const result = validateJobIntent(intent);
  assert.equal(result.ok, false);
  assert.match(result.error.code, /SENSITIVE_INPUT/);
});

test("rejects operation identifiers and resource requests outside contract bounds", () => {
  const intent = validIntent();
  intent.operation_id = "../shell";
  intent.constraints.cpu_millis = 999999999;
  assert.equal(validateJobIntent(intent).ok, false);
});

test("canonical JSON is stable regardless of object insertion order", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), canonicalJson({ a: { x: 3, y: 2 }, z: 1 }));
});

test("SHA-256 digest is deterministic and lowercase hexadecimal", async () => {
  const digest = await sha256Hex("symbiotyc.compute.v1");
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, await sha256Hex("symbiotyc.compute.v1"));
});
