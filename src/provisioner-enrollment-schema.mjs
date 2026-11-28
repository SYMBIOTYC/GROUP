const POOLS = new Set(["CLOUD-COMPUTE", "CLOUD-CPU", "CLOUD-VPS"]);
const PROVIDERS = new Set(["cloudflare", "deno", "fly", "linux_host", "other"]);
const TOP_LEVEL_KEYS = new Set([
  "protocol", "schema_version", "worker_pool", "provider",
  "provider_resource_id", "region", "runtime", "capacity"
]);
const RUNTIME_KEYS = new Set(["os", "architecture", "version"]);
const CAPACITY_KEYS = new Set([
  "cpu_millis", "memory_mib", "ephemeral_disk_mib", "max_concurrency"
]);

function hasExactKeys(value, allowed, required = [...allowed]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}

function boundedString(value, min, max) {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function boundedInteger(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

export function validateProvisionerEnrollmentRequest(value) {
  if (!hasExactKeys(value, TOP_LEVEL_KEYS, [
    "protocol", "schema_version", "worker_pool", "provider", "region", "runtime", "capacity"
  ])) return false;

  if (value.protocol !== "symbiotyc.compute.v1" ||
      typeof value.schema_version !== "string" || !/^1\.[0-9]+$/.test(value.schema_version) ||
      !POOLS.has(value.worker_pool) || !PROVIDERS.has(value.provider) ||
      (Object.hasOwn(value, "provider_resource_id") && !boundedString(value.provider_resource_id, 1, 256)) ||
      !boundedString(value.region, 1, 64)) return false;

  if (!hasExactKeys(value.runtime, RUNTIME_KEYS)) return false;
  if (!boundedString(value.runtime.os, 1, 64) ||
      !boundedString(value.runtime.architecture, 1, 64) ||
      !boundedString(value.runtime.version, 1, 64)) return false;

  if (!hasExactKeys(value.capacity, CAPACITY_KEYS)) return false;
  return boundedInteger(value.capacity.cpu_millis, 1, 1048576) &&
    boundedInteger(value.capacity.memory_mib, 16, 4194304) &&
    boundedInteger(value.capacity.ephemeral_disk_mib, 16, 4194304) &&
    boundedInteger(value.capacity.max_concurrency, 1, 4096);
}
