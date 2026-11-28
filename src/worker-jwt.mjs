const MAX_TOKEN_LENGTH = 8192;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function reject(message) {
  throw new Error(`WORKER_JWT_INVALID: ${message}`);
}

function decodeBase64Url(segment, label) {
  if (typeof segment !== "string" || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    reject(`malformed ${label} encoding`);
  }
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...bytes))
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    if (canonical !== segment) reject(`non-canonical ${label} encoding`);
    return bytes;
  } catch (error) {
    if (String(error?.message).startsWith("WORKER_JWT_INVALID:")) throw error;
    reject(`invalid ${label} encoding`);
  }
}

function decodeJsonSegment(segment, label) {
  try {
    const value = JSON.parse(decoder.decode(decodeBase64Url(segment, label)));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      reject(`${label} must be a JSON object`);
    }
    return value;
  } catch (error) {
    if (String(error?.message).startsWith("WORKER_JWT_INVALID:")) throw error;
    reject(`${label} is not valid JSON`);
  }
}

function getPublicKey(publicKeys, kid) {
  if (publicKeys instanceof Map) return publicKeys.get(kid);
  if (publicKeys && typeof publicKeys === "object") {
    return Object.hasOwn(publicKeys, kid) ? publicKeys[kid] : undefined;
  }
  return undefined;
}

function requireInteger(value, claim) {
  if (!Number.isSafeInteger(value) || value < 0) reject(`invalid ${claim} claim`);
}

function requireBoundedString(value, claim) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    reject(`invalid ${claim} claim`);
  }
}

/**
 * Verify a compact ES256 Worker JWT and bind it to the current durable
 * credential record. The resolver must read authoritative Worker/JTI/epoch
 * state; caller-provided claims are never sufficient on their own.
 *
 * @param {string} token
 * @param {{
 *   publicKeys: Map<string, CryptoKey>|Record<string, CryptoKey>,
 *   issuer: string,
 *   audience: string,
 *   nowSeconds?: number,
 *   clockSkewSeconds?: number,
 *   maxLifetimeSeconds?: number,
 *   resolveCredential: (identity: {
 *     workerId: string, jti: string, registrationEpoch: number, keyId: string
 *   }) => Promise<{
 *     active: boolean, workerId: string, jti: string,
 *     registrationEpoch: number, keyId: string
 *   }>|{
 *     active: boolean, workerId: string, jti: string,
 *     registrationEpoch: number, keyId: string
 *   }
 * }} options
 * @returns {Promise<Record<string, unknown>>} verified JWT claims
 */
export async function verifyWorkerJwt(token, options = {}) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    reject("token is missing or exceeds the size limit");
  }
  if (typeof options.issuer !== "string" || !options.issuer ||
      typeof options.audience !== "string" || !options.audience) {
    reject("issuer and audience configuration are required");
  }
  if (typeof options.resolveCredential !== "function") {
    reject("durable credential resolver is required");
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 30;
  const maxLifetime = options.maxLifetimeSeconds ?? 300;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(skew) || skew < 0 ||
      !Number.isSafeInteger(maxLifetime) || maxLifetime < 1) {
    reject("invalid verifier time configuration");
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    reject("compact JOSE format must contain exactly three non-empty segments");
  }

  const header = decodeJsonSegment(parts[0], "header");
  const allowedHeaderFields = new Set(["alg", "typ", "kid"]);
  if (Object.keys(header).some((key) => !allowedHeaderFields.has(key))) {
    reject("unsupported JOSE header parameter");
  }
  if (header.alg !== "ES256") reject("algorithm must be ES256");
  if (header.typ !== "JWT") reject("typ must be JWT");
  requireBoundedString(header.kid, "kid");

  const publicKey = getPublicKey(options.publicKeys, header.kid);
  if (!publicKey || publicKey.type !== "public" ||
      publicKey.algorithm?.name !== "ECDSA" ||
      publicKey.algorithm?.namedCurve !== "P-256" ||
      !publicKey.usages?.includes("verify")) {
    reject("unknown kid or invalid ES256 public key");
  }

  const payload = decodeJsonSegment(parts[1], "payload");
  const signature = decodeBase64Url(parts[2], "signature");
  if (signature.length !== 64) reject("ES256 signature must be 64 bytes");

  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature,
      encoder.encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    reject("signature verification failed");
  }
  if (!signatureValid) reject("signature verification failed");

  if (payload.iss !== options.issuer) reject("issuer mismatch");
  if (payload.aud !== options.audience) reject("audience mismatch");
  requireBoundedString(payload.sub, "subject");
  requireBoundedString(payload.jti, "jti");
  if (!Number.isSafeInteger(payload.registration_epoch) || payload.registration_epoch < 1) {
    reject("invalid registration_epoch claim");
  }
  requireInteger(payload.iat, "iat");
  requireInteger(payload.nbf, "nbf");
  requireInteger(payload.exp, "exp");

  if (payload.iat > now + skew) reject("issued-at time is in the future");
  if (payload.nbf > now + skew) reject("token is not yet valid");
  if (payload.nbf < payload.iat - skew || payload.nbf >= payload.exp) {
    reject("invalid nbf/exp time ordering");
  }
  if (payload.exp <= now - skew) reject("token has expired");
  if (payload.exp <= payload.iat || payload.exp - payload.iat > maxLifetime) {
    reject("token lifetime exceeds the configured maximum");
  }

  let credential;
  try {
    credential = await options.resolveCredential({
      workerId: payload.sub,
      jti: payload.jti,
      registrationEpoch: payload.registration_epoch,
      keyId: header.kid
    });
  } catch {
    reject("durable credential lookup failed");
  }
  if (!credential || credential.active !== true) {
    reject("credential is revoked or inactive");
  }
  if (credential.workerId !== payload.sub ||
      credential.jti !== payload.jti ||
      credential.registrationEpoch !== payload.registration_epoch ||
      credential.keyId !== header.kid) {
    reject("JWT identity does not match the current durable credential record");
  }

  return payload;
}
