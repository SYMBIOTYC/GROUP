import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createProvisionerAssertion } from "../provisioner/src/provisioner-assertion.mjs";
import { verifyProvisionerAssertion } from "../src/provisioner-auth.mjs";

const encoder = new TextEncoder();
const now = 1_795_875_840;
const issuer = "https://symbiotyc-group-provisioner.internal";
const audience = "symbiotyc.group.internal-enrollment.v1";
const subject = "provisioner:group-enrollment";
const kid = "provisioner-es256-2026-01";
const idempotencyKey = "enroll-worker-2026-0001";

async function fixture() {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const privateJwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", pair.privateKey);
  const privateKeyPkcs8 = Buffer.from(pkcs8).toString("base64");
  const signerEnv = {
    PROVISIONER_ISSUER: issuer,
    PROVISIONER_AUDIENCE: audience,
    PROVISIONER_SUBJECT: subject,
    PROVISIONER_KEY_ID: kid,
    PROVISIONER_SIGNING_KEY_PKCS8: privateKeyPkcs8
  };
  const verifierEnv = {
    PROVISIONER_ISSUER: issuer,
    PROVISIONER_AUDIENCE: audience,
    PROVISIONER_SUBJECT: subject,
    PROVISIONER_PUBLIC_KEYS: JSON.stringify({ [kid]: publicJwk })
  };
  return { signerEnv, verifierEnv, privateJwk };
}

const input = {
  method: "POST",
  path: "/internal/v1/worker-enrollments",
  body: { pool: "CLOUD-CPU", capacity: { cpu_cores: 8, memory_mb: 16384 } },
  idempotencyKey
};

test("signer output is accepted by GROUP verifier with identical request binding", async () => {
  const f = await fixture();
  const signed = await createProvisionerAssertion(f.signerEnv, input, { nowSeconds: now });
  assert.match(signed.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const request = new Request("https://group.internal/internal/v1/worker-enrollments", {
    method: input.method,
    headers: { authorization: `Bearer ${signed.token}` },
    body: JSON.stringify(input.body)
  });
  const verified = await verifyProvisionerAssertion(request, f.verifierEnv, {
    requestDigest: signed.requestDigest,
    idempotencyKeyHash: signed.idempotencyKeyHash,
    nowSeconds: now
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.subject, subject);
  assert.equal(verified.keyId, kid);
});

test("canonical JSON ordering produces the same request digest", async () => {
  const f = await fixture();
  const a = await createProvisionerAssertion(f.signerEnv, input, { nowSeconds: now });
  const b = await createProvisionerAssertion(f.signerEnv, {
    ...input,
    body: { capacity: { memory_mb: 16384, cpu_cores: 8 }, pool: "CLOUD-CPU" }
  }, { nowSeconds: now });
  assert.equal(a.requestDigest, b.requestDigest);
  assert.equal(a.idempotencyKeyHash, b.idempotencyKeyHash);
});

test("method, path, body, and idempotency key are cryptographically bound", async (t) => {
  const f = await fixture();
  const signed = await createProvisionerAssertion(f.signerEnv, input, { nowSeconds: now });
  const variants = [
    { ...input, method: "PUT" },
    { ...input, path: "/internal/v1/other" },
    { ...input, body: { pool: "CLOUD-VPS" } },
    { ...input, idempotencyKey: "enroll-worker-2026-0002" }
  ];
  for (const [index, variant] of variants.entries()) {
    await t.test(`variant ${index + 1}`, async () => {
      const altered = await createProvisionerAssertion(f.signerEnv, variant, { nowSeconds: now });
      assert.notEqual(altered.requestDigest, signed.requestDigest);
      if (variant.idempotencyKey !== input.idempotencyKey) {
        assert.notEqual(altered.idempotencyKeyHash, signed.idempotencyKeyHash);
      }
    });
  }
});

test("fails closed for missing key, invalid path, oversized lifetime, and private-key export", async () => {
  const f = await fixture();
  await assert.rejects(
    createProvisionerAssertion({ ...f.signerEnv, PROVISIONER_SIGNING_KEY_PKCS8: "" }, input, { nowSeconds: now }),
    /PROVISIONER_SIGNING_KEY_NOT_CONFIGURED/
  );
  await assert.rejects(
    createProvisionerAssertion(f.signerEnv, { ...input, path: "https://evil.example/x" }, { nowSeconds: now }),
    /PROVISIONER_REQUEST_INVALID/
  );
  await assert.rejects(
    createProvisionerAssertion(f.signerEnv, input, { nowSeconds: now, lifetimeSeconds: 61 }),
    /PROVISIONER_ASSERTION_OPTIONS_INVALID/
  );
  const signed = await createProvisionerAssertion(f.signerEnv, input, { nowSeconds: now });
  assert.equal(JSON.stringify(signed).includes(f.privateJwk.d), false);
});
