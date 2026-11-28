import { computeProvisionerRequestBinding } from "./provisioner-request-binding.mjs";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOCK_SKEW_SECONDS = 5;
const MAX_ASSERTION_LIFETIME_SECONDS = 60;

function failure(code) {
  return { ok: false, code };
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !BASE64URL.test(value)) throw new TypeError("invalid base64url");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJsonSegment(value) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value)));
}

function exactKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.has(key));
}

export async function verifyProvisionerAssertion(request, env, {
  nowSeconds = Math.floor(Date.now() / 1000)
} = {}) {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(authorization);
  if (!match) return failure("PROVISIONER_ASSERTION_REQUIRED");

  const binding = await computeProvisionerRequestBinding(request);
  if (!binding.ok) return failure("PROVISIONER_REQUEST_BINDING_INVALID");
  const { requestDigest, idempotencyKeyHash } = binding;

  if (typeof env?.PROVISIONER_ISSUER !== "string" ||
      typeof env?.PROVISIONER_AUDIENCE !== "string" ||
      typeof env?.PROVISIONER_SUBJECT !== "string" ||
      typeof env?.PROVISIONER_PUBLIC_KEYS !== "string") {
    return failure("PROVISIONER_TRUST_NOT_CONFIGURED");
  }

  try {
    const parts = match[1].split(".");
    if (parts.length !== 3) return failure("PROVISIONER_ASSERTION_INVALID");
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    const header = decodeJsonSegment(encodedHeader);
    const claims = decodeJsonSegment(encodedClaims);

    if (!exactKeys(header, new Set(["alg", "typ", "kid"])) ||
        header.alg !== "ES256" || header.typ !== "JWT" ||
        typeof header.kid !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(header.kid)) {
      return failure("PROVISIONER_ASSERTION_INVALID");
    }

    const allowedClaims = new Set(["iss", "aud", "sub", "iat", "nbf", "exp", "jti", "rqh", "ikh"]);
    if (!exactKeys(claims, allowedClaims) ||
        claims.iss !== env.PROVISIONER_ISSUER ||
        claims.aud !== env.PROVISIONER_AUDIENCE ||
        claims.sub !== env.PROVISIONER_SUBJECT ||
        !Number.isSafeInteger(claims.iat) ||
        !Number.isSafeInteger(claims.nbf) ||
        !Number.isSafeInteger(claims.exp) ||
        !UUID.test(claims.jti || "") ||
        claims.rqh !== requestDigest ||
        claims.ikh !== idempotencyKeyHash) {
      return failure("PROVISIONER_ASSERTION_INVALID");
    }

    if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
        claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS ||
        claims.nbf < claims.iat - CLOCK_SKEW_SECONDS ||
        claims.nbf >= claims.exp ||
        claims.exp <= nowSeconds ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > MAX_ASSERTION_LIFETIME_SECONDS ||
        nowSeconds - claims.iat > MAX_ASSERTION_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS) {
      return failure("PROVISIONER_ASSERTION_INVALID");
    }

    let keySet;
    try {
      keySet = JSON.parse(env.PROVISIONER_PUBLIC_KEYS);
    } catch {
      return failure("PROVISIONER_TRUST_NOT_CONFIGURED");
    }
    const jwk = keySet && typeof keySet === "object" && !Array.isArray(keySet) && Object.hasOwn(keySet, header.kid)
      ? keySet[header.kid]
      : null;
    if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" ||
        typeof jwk.x !== "string" || typeof jwk.y !== "string" ||
        jwk.d !== undefined) {
      return failure("PROVISIONER_ASSERTION_INVALID");
    }

    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      decodeBase64Url(encodedSignature),
      signingInput
    );
    if (!valid) return failure("PROVISIONER_ASSERTION_INVALID");

    return { ok: true, subject: claims.sub, jti: claims.jti, keyId: header.kid, requestDigest, idempotencyKeyHash, body: binding.body };
  } catch {
    return failure("PROVISIONER_ASSERTION_INVALID");
  }
}
