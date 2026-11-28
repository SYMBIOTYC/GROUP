import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { verifyWorkerJwt } from "../src/worker-jwt.mjs";

const encoder = new TextEncoder();
const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const jsonPart = (value) => b64u(encoder.encode(JSON.stringify(value)));
const now = 1_800_000_000;

async function fixture(overrides = {}, options = {}) {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const header = { alg: "ES256", typ: "JWT", kid: "group-2026-01" };
  const payload = {
    iss: "https://group.symbiotyc.internal",
    aud: "symbiotyc.compute.worker-heartbeat.v1",
    sub: "worker-123",
    registration_epoch: 7,
    jti: "credential-jti-001",
    iat: now,
    nbf: now,
    exp: now + 300,
    ...overrides
  };
  const signingInput = `${jsonPart(header)}.${jsonPart(payload)}`;
  const signature = new Uint8Array(await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, pair.privateKey, encoder.encode(signingInput)
  ));
  const token = `${signingInput}.${b64u(signature)}`;
  const publicKey = await webcrypto.subtle.importKey(
    "jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
  );
  return {
    token,
    options: {
      publicKeys: new Map([["group-2026-01", publicKey]]),
      issuer: "https://group.symbiotyc.internal",
      audience: "symbiotyc.compute.worker-heartbeat.v1",
      nowSeconds: now,
      clockSkewSeconds: 30,
      maxLifetimeSeconds: 300,
      resolveCredential: async ({ workerId, jti, registrationEpoch, keyId }) => ({
        active: true, workerId, jti, registrationEpoch, keyId
      }),
      ...options
    }
  };
}

test("accepts a valid ES256 Worker JWT bound to its current credential record", async () => {
  const f = await fixture();
  const claims = await verifyWorkerJwt(f.token, f.options);
  assert.equal(claims.sub, "worker-123");
  assert.equal(claims.registration_epoch, 7);
  assert.equal(claims.jti, "credential-jti-001");
});

test("rejects alg none and algorithm substitution", async () => {
  const f = await fixture();
  const parts = f.token.split(".");
  const header = jsonPart({ alg: "none", typ: "JWT", kid: "group-2026-01" });
  await assert.rejects(verifyWorkerJwt(`${header}.${parts[1]}.${parts[2]}`, f.options), /algorithm/i);
  const hs = jsonPart({ alg: "HS256", typ: "JWT", kid: "group-2026-01" });
  await assert.rejects(verifyWorkerJwt(`${hs}.${parts[1]}.${parts[2]}`, f.options), /algorithm/i);
});

test("rejects malformed compact JOSE tokens and non-JSON headers", async () => {
  const f = await fixture();
  await assert.rejects(verifyWorkerJwt("a.b", f.options), /compact|format/i);
  await assert.rejects(verifyWorkerJwt(`${b64u(encoder.encode("not-json"))}.e30.AA`, f.options), /header|json/i);
});

test("rejects unknown kid and invalid signature", async () => {
  const f = await fixture();
  await assert.rejects(verifyWorkerJwt(f.token, { ...f.options, publicKeys: new Map() }), /kid|key/i);
  const parts = f.token.split(".");
  const bad = `${parts[0]}.${parts[1]}.${b64u(new Uint8Array(64))}`;
  await assert.rejects(verifyWorkerJwt(bad, f.options), /signature/i);
});

test("rejects issuer and audience mismatch", async () => {
  for (const override of [{ iss: "https://attacker.invalid" }, { aud: "other-service" }]) {
    const f = await fixture(override);
    await assert.rejects(verifyWorkerJwt(f.token, f.options), /issuer|audience/i);
  }
});

test("rejects not-yet-valid, expired, and overlong credentials", async () => {
  for (const override of [
    { nbf: now + 60 },
    { exp: now - 1 },
    { exp: now + 301 }
  ]) {
    const f = await fixture(override);
    await assert.rejects(verifyWorkerJwt(f.token, f.options), /time|valid|lifetime|exp|nbf/i);
  }
});

test("rejects future-issued credentials beyond configured clock skew", async () => {
  const f = await fixture({ iat: now + 60, nbf: now + 60, exp: now + 300 });
  await assert.rejects(verifyWorkerJwt(f.token, f.options), /issued|time|future/i);
});

test("rejects missing or malformed identity claims", async () => {
  const f = await fixture({ sub: "", registration_epoch: 0, jti: "" });
  await assert.rejects(verifyWorkerJwt(f.token, f.options), /subject|epoch|jti|claim/i);
});

test("rejects revoked JTI and stale registration epoch from durable credential lookup", async () => {
  const revoked = await fixture({}, {
    resolveCredential: async () => ({ active: false, reason: "revoked" })
  });
  await assert.rejects(verifyWorkerJwt(revoked.token, revoked.options), /revok|inactive|credential/i);

  const stale = await fixture({}, {
    resolveCredential: async () => ({
      active: true, workerId: "worker-123", jti: "credential-jti-001",
      registrationEpoch: 8, keyId: "group-2026-01"
    })
  });
  await assert.rejects(verifyWorkerJwt(stale.token, stale.options), /epoch|credential/i);
});

test("rejects credential records bound to another worker, JTI, or key id", async () => {
  for (const record of [
    { active: true, workerId: "other-worker", jti: "credential-jti-001", registrationEpoch: 7, keyId: "group-2026-01" },
    { active: true, workerId: "worker-123", jti: "other-jti", registrationEpoch: 7, keyId: "group-2026-01" },
    { active: true, workerId: "worker-123", jti: "credential-jti-001", registrationEpoch: 7, keyId: "other-key" }
  ]) {
    const f = await fixture({}, { resolveCredential: async () => record });
    await assert.rejects(verifyWorkerJwt(f.token, f.options), /credential|worker|jti|key/i);
  }
});

test("requires a durable credential resolver and a fixed issuer/audience", async () => {
  const f = await fixture();
  await assert.rejects(verifyWorkerJwt(f.token, { ...f.options, resolveCredential: undefined }), /resolver|credential/i);
  await assert.rejects(verifyWorkerJwt(f.token, { ...f.options, issuer: undefined }), /issuer|configuration/i);
  await assert.rejects(verifyWorkerJwt(f.token, { ...f.options, audience: undefined }), /audience|configuration/i);
});
