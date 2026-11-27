const TOP_LEVEL_KEYS = new Set([
  "protocol", "schema_version", "operation_id", "input", "constraints",
  "output_policy", "deadline_at", "client_reference"
]);
const CONSTRAINT_KEYS = new Set([
  "worker_pool", "required_capabilities", "cpu_millis", "memory_mib",
  "ephemeral_disk_mib", "timeout_seconds", "max_attempts"
]);
const OUTPUT_KEYS = new Set(["format", "max_bytes", "media_types"]);
const WORKER_POOLS = new Set(["CLOUD-COMPUTE", "CLOUD-CPU", "CLOUD-VPS"]);
const SENSITIVE_KEY = /(password|passwd|token|secret|credential|api[_-]?key|private[_-]?key|authorization|cookie|access[_-]?key|client[_-]?secret|refresh[_-]?token)/i;
const MAX_INPUT_BYTES = 64 * 1024;

const fail = (code, message) => ({ ok: false, error: { code, message } });
const isObject = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function hasSensitiveKey(value) {
  if (Array.isArray(value)) return value.some(hasSensitiveKey);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, child]) => SENSITIVE_KEY.test(key) || hasSensitiveKey(child));
}

function isJsonValue(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every((item) => isJsonValue(item, depth + 1));
  if (!isObject(value)) return false;
  return Object.keys(value).length <= 128 &&
    Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function onlyKeys(value, allowed) {
  return isObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function boundedInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function validateJobIntent(value) {
  if (!onlyKeys(value, TOP_LEVEL_KEYS)) return fail("INVALID_JOB_INTENT", "JobIntent must be an object containing only protocol-defined fields.");
  if (value.protocol !== "symbiotyc.compute.v1" || !/^1\.[0-9]+$/.test(value.schema_version ?? "")) {
    return fail("UNSUPPORTED_PROTOCOL", "Unsupported compute protocol or schema version.");
  }
  if (typeof value.operation_id !== "string" || !/^[a-z][a-z0-9_.-]{1,127}$/.test(value.operation_id)) {
    return fail("INVALID_OPERATION_ID", "operation_id must be a bounded allowlist identifier.");
  }
  if (!isObject(value.input) || !isJsonValue(value.input)) {
    return fail("INVALID_INPUT", "input must be a bounded JSON object.");
  }
  if (hasSensitiveKey(value.input)) {
    return fail("SENSITIVE_INPUT_REJECTED", "Credential-like input fields are not accepted; secret references are not enabled in this runtime phase.");
  }
  if (new TextEncoder().encode(JSON.stringify(value.input)).byteLength > MAX_INPUT_BYTES) {
    return fail("INPUT_TOO_LARGE", "Job input exceeds the 64 KiB inline limit.");
  }

  if (!isObject(value.constraints)) return fail("INVALID_CONSTRAINTS", "constraints must be an object.");
  const rawConstraints = value.constraints;
  if (!onlyKeys(rawConstraints, CONSTRAINT_KEYS)) return fail("INVALID_CONSTRAINTS", "constraints contains an unsupported field.");
  const constraints = {
    worker_pool: rawConstraints.worker_pool,
    required_capabilities: rawConstraints.required_capabilities ?? [],
    cpu_millis: rawConstraints.cpu_millis ?? 1000,
    memory_mib: rawConstraints.memory_mib ?? 512,
    ephemeral_disk_mib: rawConstraints.ephemeral_disk_mib ?? 512,
    timeout_seconds: rawConstraints.timeout_seconds ?? 300,
    max_attempts: rawConstraints.max_attempts ?? 1
  };
  if (constraints.worker_pool !== undefined && !WORKER_POOLS.has(constraints.worker_pool)) {
    return fail("INVALID_WORKER_POOL", "worker_pool is not a supported execution pool.");
  }
  if (!Array.isArray(constraints.required_capabilities) || constraints.required_capabilities.length > 32 ||
      !constraints.required_capabilities.every((item) => typeof item === "string" && item.length > 0 && item.length <= 64) ||
      new Set(constraints.required_capabilities).size !== constraints.required_capabilities.length) {
    return fail("INVALID_CAPABILITIES", "required_capabilities must contain at most 32 bounded strings.");
  }
  if (!boundedInteger(constraints.cpu_millis, 1, 65536) ||
      !boundedInteger(constraints.memory_mib, 16, 1048576) ||
      !boundedInteger(constraints.ephemeral_disk_mib, 16, 1048576) ||
      !boundedInteger(constraints.timeout_seconds, 1, 86400) ||
      !boundedInteger(constraints.max_attempts, 1, 10)) {
    return fail("RESOURCE_LIMIT_OUT_OF_RANGE", "Requested resource limits exceed protocol bounds.");
  }

  if (!onlyKeys(value.output_policy, OUTPUT_KEYS) ||
      !["json", "text", "binary"].includes(value.output_policy.format) ||
      !boundedInteger(value.output_policy.max_bytes, 1, 1073741824)) {
    return fail("INVALID_OUTPUT_POLICY", "output_policy requires a supported format and bounded max_bytes.");
  }
  if (value.output_policy.media_types !== undefined &&
      (!Array.isArray(value.output_policy.media_types) || value.output_policy.media_types.length > 32 ||
       !value.output_policy.media_types.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128) ||
       new Set(value.output_policy.media_types).size !== value.output_policy.media_types.length)) {
    return fail("INVALID_OUTPUT_POLICY", "media_types must be a bounded string array.");
  }
  if (value.deadline_at !== undefined) {
    const deadline = Date.parse(value.deadline_at);
    if (typeof value.deadline_at !== "string" || !Number.isFinite(deadline) || deadline <= Date.now()) {
      return fail("INVALID_DEADLINE", "deadline_at must be a valid future timestamp.");
    }
  }
  if (value.client_reference !== undefined &&
      (typeof value.client_reference !== "string" || value.client_reference.length > 128)) {
    return fail("INVALID_CLIENT_REFERENCE", "client_reference must be at most 128 characters.");
  }

  return {
    ok: true,
    value: {
      protocol: value.protocol,
      schema_version: value.schema_version,
      operation_id: value.operation_id,
      input: value.input,
      constraints,
      output_policy: {
        format: value.output_policy.format,
        max_bytes: value.output_policy.max_bytes,
        ...(value.output_policy.media_types ? { media_types: value.output_policy.media_types } : {})
      },
      ...(value.deadline_at ? { deadline_at: value.deadline_at } : {}),
      ...(value.client_reference ? { client_reference: value.client_reference } : {})
    }
  };
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
