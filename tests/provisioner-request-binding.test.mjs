import test from "node:test";
import assert from "node:assert/strict";
import { computeProvisionerRequestBinding } from "../src/provisioner-request-binding.mjs";

const url = "https://group.internal/internal/v1/worker-enrollments";
const body = JSON.stringify({ pool: "CLOUD-CPU", capacity: { memory_mb: 16384, cpu_cores: 8 } });
const key = "enroll-worker-2026-0001";

function request({ method = "POST", target = url, payload = body, idempotencyKey = key, headers = {} } = {}) {
  return new Request(target, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-symbiotyc-request-digest": "f".repeat(64),
      "x-symbiotyc-idempotency-hash": "e".repeat(64),
      ...headers
    },
    body: payload
  });
}

test("computes binding from the actual Request and ignores caller-supplied digest headers", async () => {
  const a = await computeProvisionerRequestBinding(request());
  const b = await computeProvisionerRequestBinding(request({
    headers: {
      "x-symbiotyc-request-digest": "0".repeat(64),
      "x-symbiotyc-idempotency-hash": "1".repeat(64)
    }
  }));
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.requestDigest, b.requestDigest);
  assert.equal(a.idempotencyKeyHash, b.idempotencyKeyHash);
  assert.deepEqual(a.body, JSON.parse(body));
});

test("binds the digest to method, exact pathname, and canonical parsed JSON body", async (t) => {
  const baseline = await computeProvisionerRequestBinding(request());
  const invalidVariants = [
    ["method", request({ method: "PUT" })],
    ["path", request({ target: "https://group.internal/internal/v1/other" })],
    ["query", request({ target: url + "?override=1" })]
  ];
  for (const [name, candidate] of invalidVariants) {
    await t.test(name, async () => {
      const result = await computeProvisionerRequestBinding(candidate);
      assert.equal(result.ok, false);
    });
  }
  await t.test("body", async () => {
    const changed = await computeProvisionerRequestBinding(request({
      payload: JSON.stringify({ pool: "CLOUD-VPS" })
    }));
    assert.equal(changed.ok, true);
    assert.notEqual(changed.requestDigest, baseline.requestDigest);
  });
  const reordered = await computeProvisionerRequestBinding(request({
    payload: JSON.stringify({ capacity: { cpu_cores: 8, memory_mb: 16384 }, pool: "CLOUD-CPU" })
  }));
  assert.equal(reordered.ok, true);
  assert.equal(reordered.requestDigest, baseline.requestDigest);
});

test("hashes the actual Idempotency-Key independently", async () => {
  const a = await computeProvisionerRequestBinding(request());
  const b = await computeProvisionerRequestBinding(request({ idempotencyKey: "enroll-worker-2026-0002" }));
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.requestDigest, b.requestDigest);
  assert.notEqual(a.idempotencyKeyHash, b.idempotencyKeyHash);
});

test("fails closed for missing or malformed idempotency keys and invalid JSON bodies", async (t) => {
  for (const [name, candidate] of [
    ["missing key", request({ headers: { "idempotency-key": "" } })],
    ["malformed key", request({ idempotencyKey: "short" })],
    ["invalid JSON", request({ payload: "{" })],
    ["array body", request({ payload: "[]" })],
    ["non-JSON content type", request({ headers: { "content-type": "text/plain" } })]
  ]) {
    await t.test(name, async () => {
      const result = await computeProvisionerRequestBinding(candidate);
      assert.equal(result.ok, false);
    });
  }
});
