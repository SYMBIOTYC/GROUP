const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_KID = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;
const MAX_LIFETIME_SECONDS = 60;
const encoder = new TextEncoder();

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("PROVISIONER_SIGNING_KEY_INVALID");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function canonicalJson(value, depth = 0) {
  if (depth > 32) throw new Error("PROVISIONER_REQUEST_INVALID");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("PROVISIONER_REQUEST_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(",")}}`;
  }
  throw new Error("PROVISIONER_REQUEST_INVALID");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateInput(input) {
  if (!input || typeof input !== "object" ||
      typeof input.method !== "string" || !/^[A-Z]{3,10}$/.test(input.method) ||
      typeof input.path !== "string" || !input.path.startsWith("/") ||
      input.path.startsWith("//") || input.path.includes("?") ||
      input.path.includes("#") || input.path.includes("\\") ||
      /[\x00-\x20\x7f]/.test(input.path) ||
      !SAFE_IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
      !Object.hasOwn(input, "body")) {
    throw new Error("PROVISIONER_REQUEST_INVALID");
  }
}

export async function createProvisionerAssertion(env, input, {
  nowSeconds = Math.floor(Date.now() / 1000),
  lifetimeSeconds = 45,
  jti = crypto.randomUUID()
} = {}) {
  validateInput(input);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1 ||
      !Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1 ||
      lifetimeSeconds > MAX_LIFETIME_SECONDS ||
      typeof jti !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jti)) {
    throw new Error("PROVISIONER_ASSERTION_OPTIONS_INVALID");
  }

  if (typeof env?.PROVISIONER_SIGNING_KEY_PKCS8 !== "string" ||
      !env.PROVISIONER_SIGNING_KEY_PKCS8 ||
      typeof env.PROVISIONER_ISSUER !== "string" || !env.PROVISIONER_ISSUER ||
      typeof env.PROVISIONER_AUDIENCE !== "string" || !env.PROVISIONER_AUDIENCE ||
      typeof env.PROVISIONER_SUBJECT !== "string" || !env.PROVISIONER_SUBJECT ||
      typeof env.PROVISIONER_KEY_ID !== "string" || !SAFE_KID.test(env.PROVISIONER_KEY_ID)) {
    throw new Error("PROVISIONER_SIGNING_KEY_NOT_CONFIGURED");
  }

  const canonicalBody = canonicalJson(input.body);
  const requestEnvelope = canonicalJson({
    method: input.method,
    path: input.path,
    body: JSON.parse(canonicalBody)
  });
  const requestDigest = await sha256Hex(requestEnvelope);
  const idempotencyKeyHash = await sha256Hex(input.idempotencyKey);
  if (!SHA256_HEX.test(requestDigest) || !SHA256_HEX.test(idempotencyKeyHash)) {
    throw new Error("PROVISIONER_REQUEST_INVALID");
  }

  let privateKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      decodeBase64(env.PROVISIONER_SIGNING_KEY_PKCS8),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
  } catch {
    throw new Error("PROVISIONER_SIGNING_KEY_INVALID");
  }

  const header = {
    alg: "ES256",
    typ: "JWT",
    kid: env.PROVISIONER_KEY_ID
  };
  const claims = {
    iss: env.PROVISIONER_ISSUER,
    aud: env.PROVISIONER_AUDIENCE,
    sub: env.PROVISIONER_SUBJECT,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + lifetimeSeconds,
    jti,
    rqh: requestDigest,
    ikh: idempotencyKeyHash
  };
  const signingInput = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(signingInput)
  );

  return {
    token: `${signingInput}.${base64url(new Uint8Array(signature))}`,
    requestDigest,
    idempotencyKeyHash,
    expiresAt: claims.exp
  };
}
