import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createProvisionerAssertion } from "../provisioner/src/provisioner-assertion.mjs";
import { prepareProvisionerEnrollment } from "../src/provisioner-enrollment-handler.mjs";

const now = 1_795_875_840;
const issuer = "https://symbiotyc-group-provisioner.internal";
const audience = "symbiotyc.group.internal-enrollment.v1";
const subject = "provisioner:group-enrollment";
const kid = "provisioner-es256-2026-01";
const idempotencyKey = "enroll-worker-2026-0001";
const validBody = {
  protocol: "symbiotyc.compute.v1",
  schema_version: "1.0",
  worker_pool: "CLOUD-CPU",
  provider: "linux_host",
  region: "eu-west",
  runtime: { os: "linux", architecture: "x86_64", version: "1" },
  capacity: { cpu_millis: 2000, memory_mib: 4096, ephemeral_disk_mib: 20480, max_concurrency: 2 }
};

async function fixture() {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", pair.privateKey);
  const signerEnv = {
    PROVISIONER_ISSUER: issuer,
    PROVISIONER_AUDIENCE: audience,
    PROVISIONER_SUBJECT: subject,
    PROVISIONER_KEY_ID: kid,
    PROVISIONER_SIGNING_KEY_PKCS8: Buffer.from(pkcs8).toString("base64")
  };
  const verifierEnv = {
    PROVISIONER_ISSUER: issuer,
    PROVISIONER_AUDIENCE: audience,
    PROVISIONER_SUBJECT: subject,
    PROVISIONER_PUBLIC_KEYS: JSON.stringify({ [kid]: publicJwk })
  };
  return { signerEnv, verifierEnv };
}

async function signedRequest(f, body = validBody, key = idempotencyKey) {
  const input = {
    method: "POST",
    path: "/internal/v1/worker-enrollments",
    body,
    idempotencyKey: key
  };
  const signed = await createProvisionerAssertion(f.signerEnv, input, { nowSeconds: now });
  return new Request("https://group.internal/internal/v1/worker-enrollments", {
    method: "POST",
    headers: {
      authorization: `Bearer ${signed.token}`,
      "content-type": "application/json",
      "idempotency-key": key,
      "x-symbiotyc-caller": "amphetamin",
      "x-symbiotyc-request-digest": "f".repeat(64)
    },
    body: JSON.stringify(body)
  });
}

test("prepares a valid enrollment from the verified request body without mutating storage", async () => {
  const f = await fixture();
  const request = await signedRequest(f);
  const result = await prepareProvisionerEnrollment(request, f.verifierEnv, { nowSeconds: now });
  assert.equal(result.ok, true);
  assert.equal(result.subject, subject);
  assert.deepEqual(result.enrollmentRequest, validBody);
  assert.match(result.requestDigest, /^[a-f0-9]{64}$/);
  assert.match(result.idempotencyKeyHash, /^[a-f0-9]{64}$/);
});

test("rejects schema-invalid content even when the Provisioner signature is valid", async () => {
  const f = await fixture();
  const invalid = { ...validBody, tenant_id: "attacker-tenant" };
  const request = await signedRequest(f, invalid);
  const result = await prepareProvisionerEnrollment(request, f.verifierEnv, { nowSeconds: now });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROVISIONER_ENROLLMENT_SCHEMA_INVALID");
});

test("rejects invalid nested capacity and missing required fields", async () => {
  const f = await fixture();
  for (const body of [
    { ...validBody, capacity: { ...validBody.capacity, cpu_millis: 1048577 } },
    { ...validBody, runtime: { os: "linux" } }
  ]) {
    const result = await prepareProvisionerEnrollment(await signedRequest(f, body), f.verifierEnv, { nowSeconds: now });
    assert.equal(result.ok, false);
    assert.equal(result.code, "PROVISIONER_ENROLLMENT_SCHEMA_INVALID");
  }
});

test("does not accept a forged AMPHETAMIN caller marker as Provisioner authority", async () => {
  const f = await fixture();
  const request = new Request("https://group.internal/internal/v1/worker-enrollments", {
    method: "POST",
    headers: {
      "x-symbiotyc-caller": "amphetamin",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify(validBody)
  });
  const result = await prepareProvisionerEnrollment(request, f.verifierEnv, { nowSeconds: now });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROVISIONER_ASSERTION_REQUIRED");
});

test("keeps the original request body readable after verification and validation", async () => {
  const f = await fixture();
  const request = await signedRequest(f);
  const result = await prepareProvisionerEnrollment(request, f.verifierEnv, { nowSeconds: now });
  assert.equal(result.ok, true);
  assert.deepEqual(await request.json(), validBody);
});

test("rejects unsupported method and path without exposing enrollment data", async () => {
  const f = await fixture();
  const request = await signedRequest(f);
  const altered = new Request("https://group.internal/internal/v1/other", {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(validBody)
  });
  const result = await prepareProvisionerEnrollment(altered, f.verifierEnv, { nowSeconds: now });
  assert.equal(result.ok, false);
});

test("accepts the optional bounded provider resource identifier", async () => {
  const f = await fixture();
  const body = { ...validBody, provider_resource_id: "provider-instance-123" };
  const result = await prepareProvisionerEnrollment(await signedRequest(f, body), f.verifierEnv, { nowSeconds: now });
  assert.equal(result.ok, true);
  assert.equal(result.enrollmentRequest.provider_resource_id, "provider-instance-123");
});

test("rejects an unsupported schema version even with a valid signature", async () => {
  const f = await fixture();
  const body = { ...validBody, schema_version: "2.0" };
  const result = await prepareProvisionerEnrollment(await signedRequest(f, body), f.verifierEnv, { nowSeconds: now });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROVISIONER_ENROLLMENT_SCHEMA_INVALID");
});

test("does not inspect or mutate the database binding", async () => {
  const f = await fixture();
  const request = await signedRequest(f);
  const env = new Proxy(f.verifierEnv, {
    get(target, property) {
      if (property === "DB") throw new Error("DB binding must not be accessed");
      return target[property];
    }
  });
  const result = await prepareProvisionerEnrollment(request, env, { nowSeconds: now });
  assert.equal(result.ok, true);
});
