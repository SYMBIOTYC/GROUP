const SHA256_HEX = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;
const EXPECTED_METHOD = "POST";
const EXPECTED_PATH = "/internal/v1/worker-enrollments";
const MAX_BODY_BYTES = 64 * 1024;
const encoder = new TextEncoder();

function failure() {
  return { ok: false, code: "PROVISIONER_REQUEST_BINDING_INVALID" };
}

function canonicalJson(value, depth = 0) {
  if (depth > 32) throw new TypeError("body depth exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(",")}}`;
  }
  throw new TypeError("unsupported JSON value");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function computeProvisionerRequestBinding(request) {
  try {
    if (!(request instanceof Request) || request.method !== EXPECTED_METHOD) return failure();

    const url = new URL(request.url);
    if (url.pathname !== EXPECTED_PATH || url.search || url.hash ||
    if (url.pathname !== EXPECTED_PATH || url.search || url.hash ||
      return failure();
    }

    const idempotencyKey = request.headers.get("idempotency-key") || "";
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return failure();

    const contentType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") return failure();

    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return failure();

    const rawBody = await request.clone().text();
    if (!rawBody || encoder.encode(rawBody).byteLength > MAX_BODY_BYTES) return failure();

    const body = JSON.parse(rawBody);
    if (!body || typeof body !== "object" || Array.isArray(body)) return failure();

    const canonicalBody = canonicalJson(body);
    const envelope = canonicalJson({
      method: EXPECTED_METHOD,
      path: EXPECTED_PATH,
      body: JSON.parse(canonicalBody)
    });
    const requestDigest = await sha256Hex(envelope);
    const idempotencyKeyHash = await sha256Hex(idempotencyKey);
    if (!SHA256_HEX.test(requestDigest) || !SHA256_HEX.test(idempotencyKeyHash)) return failure();

    return { ok: true, requestDigest, idempotencyKeyHash, method: EXPECTED_METHOD, path: EXPECTED_PATH, body };
  } catch {
    return failure();
  }
}
