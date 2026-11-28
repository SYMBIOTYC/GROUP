import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { verifyProvisionerAssertion } from "../src/provisioner-auth.mjs";

const encoder = new TextEncoder();
const now = 1_795_875_840;
const requestDigest = "2ba7e2793c93307244d9d36b11f78a92928d023e8ad434a729561d7ee367b29f";
const idempotencyKeyHash = "57c3a743ecdc0f88a137b0210bf22875f9acad8dd596456db2869f796e2d1a88";
const issuer = "https://symbiotyc-group-provisioner.internal";
const audience = "symbiotyc.group.internal-enrollment.v1";
const subject = "provisioner:group-enrollment";
const kid = "provisioner-es256-2026-01";

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function fixture() {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const env = {
    PROVISIONER_PUBLIC_KEYS: JSON.stringify({ [kid]: jwk }),
    PROVISIONER_ISSUER: issuer,
    PROVISIONER_AUDIENCE: audience,
    PROVISIONER_SUBJECT: subject
  };
  async function token(overrides = {}, signingKey = pair.privateKey, headerOverrides = {}) {
    const header = { alg: "ES256", typ: "JWT", kid, ...headerOverrides };
    const claims = {
      iss: issuer,
      aud: audience,
      sub: subject,
      iat: now,
      nbf: now,
      exp: now + 45,
      jti: "6d4c7a18-64bd-4a21-8e7f-2e13b19b2b81",
      rqh: requestDigest,
      ikh: idempotencyKeyHash,
      ...overrides
    };
    const input = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
    const signature = await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      encoder.encode(input)
    );
    return `${input}.${base64url(signature)}`;
  }
  return { env, token, pair };
}

test("accepts a valid, request-bound ES256 Provisioner assertion", async () => {
  const f = await fixture();
  const jwt = await f.token();
  const request = new Request("https://group.internal/internal/v1/worker-enrollments", {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "x-symbiotyc-caller": "amphetamin", "content-type": "application/json", "idempotency-key": "enroll-worker-2026-0001" },
    body: "{}"
  });
  const result = await verifyProvisionerAssertion(request, f.env, { requestDigest, idempotencyKeyHash, nowSeconds: now });
  assert.equal(result.ok, true);
  assert.equal(result.subject, subject);
});

test("rejects a forged caller marker without a signed bearer assertion", async () => {
  const f = await fixture();
  const request = new Request("https://group.internal/internal/v1/worker-enrollments", {
    method: "POST",
    headers: { "x-symbiotyc-caller": "provisioner" },
    body: "{}"
  });
  const result = await verifyProvisionerAssertion(request, f.env, { requestDigest, idempotencyKeyHash, nowSeconds: now });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROVISIONER_ASSERTION_REQUIRED");
});

test("rejects an AMPHETAMIN assertion even when its marker is present", async () => {
  const f = await fixture();
  const jwt = await f.token({ sub: "amphetamin:service" });
  const request = new Request("https://group.internal/internal/v1/worker-enrollments", {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "x-symbiotyc-caller": "amphetamin", "content-type": "application/json", "idempotency-key": "enroll-worker-2026-0001" },
    body: "{}"
  });
  const result = await verifyProvisionerAssertion(request, f.env, { requestDigest, idempotencyKeyHash, nowSeconds: now });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROVISIONER_ASSERTION_INVALID");
});

test("rejects wrong audience, expiry, changed request body, and changed Idempotency-Key", async (t) => {
  const f = await fixture();
  for (const [name, claims, body, key] of [
    ["wrong audience", { aud: "symbiotyc.compute.worker-heartbeat.v1" }, "{}", "enroll-worker-2026-0001"],
    ["expired", { exp: now }, "{}", "enroll-worker-2026-0001"],
    ["different request body", {}, '{"pool":"CLOUD-VPS"}', "enroll-worker-2026-0001"],
    ["different idempotency key", {}, "{}", "enroll-worker-2026-0002"]
  ]) {
    await t.test(name, async () => {
      const jwt = await f.token(claims);
      const request = new Request("https://group.internal/internal/v1/worker-enrollments", {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", "idempotency-key": key },
        body
      });
      const result = await verifyProvisionerAssertion(request, f.env, { nowSeconds: now });
      assert.equal(result.ok, false);
      assert.equal(result.code, "PROVISIONER_ASSERTION_INVALID");
    });
  }
});

test("rejects algorithm substitution and invalid signatures", async () => {
  const f = await fixture();
  const wrongAlgorithm = await f.token({}, f.pair.privateKey, { alg: "none" });
  const requestA = new Request("https://group.internal/internal/v1/worker-enrollments", {
    method: "POST", headers: { authorization: `Bearer ${wrongAlgorithm}`, "content-type": "application/json", "idempotency-key": "enroll-worker-2026-0001" }, body: "{}"
  });
  const resultA = await verifyProvisionerAssertion(requestA, f.env, { requestDigest, idempotencyKeyHash, nowSeconds: now });
  assert.equal(resultA.ok, false);

  const otherPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const wrongSignature = await f.token({}, otherPair.privateKey);
  const requestB = new Request("https://group.internal/internal/v1/worker-enrollments", {
    method: "POST", headers: { authorization: `Bearer ${wrongSignature}`, "content-type": "application/json", "idempotency-key": "enroll-worker-2026-0001" }, body: "{}"
  });
  const resultB = await verifyProvisionerAssertion(requestB, f.env, { requestDigest, idempotencyKeyHash, nowSeconds: now });
  assert.equal(resultB.ok, false);
});
