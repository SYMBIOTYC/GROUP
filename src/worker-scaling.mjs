const MAX_UINT32_RANGE = 0x1_0000_0000;

function assertInteger(value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer in [${minimum}, ${maximum}]`);
  }
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("policy must be an object");
  }
  assertInteger(policy.min_quality_score, "policy.min_quality_score", 0, 100);
  assertInteger(policy.demand_units_per_worker, "policy.demand_units_per_worker", 1);
  assertInteger(policy.min_workers, "policy.min_workers", 1);
  assertInteger(policy.max_workers, "policy.max_workers", policy.min_workers);
}

/**
 * Calculates the allowed Worker count interval. It is deliberately pure:
 * quota, capacity, quality evidence, and policy are supplied by GROUP callers.
 */
export function calculateWorkerCountBounds({
  quality_score,
  quality_gate_passed,
  demand_units,
  quota_workers,
  healthy_capacity,
  policy
}) {
  if (typeof quality_score !== "number" || !Number.isFinite(quality_score) ||
      quality_score < 0 || quality_score > 100) {
    throw new TypeError("quality_score must be a finite number in [0, 100]");
  }
  if (typeof quality_gate_passed !== "boolean") {
    throw new TypeError("quality_gate_passed must be a boolean");
  }
  assertInteger(demand_units, "demand_units", 1);
  assertInteger(quota_workers, "quota_workers", 0);
  assertInteger(healthy_capacity, "healthy_capacity", 0);
  validatePolicy(policy);

  const blocked = (reason) => ({
    eligible: false,
    reason,
    min_workers: 0,
    max_workers: 0
  });

  if (!quality_gate_passed) return blocked("QUALITY_GATE_FAILED");
  if (quality_score < policy.min_quality_score) return blocked("QUALITY_BELOW_POLICY");
  if (quota_workers === 0 || healthy_capacity === 0) return blocked("NO_ELIGIBLE_CAPACITY");

  const demandCeiling = Math.ceil(demand_units / policy.demand_units_per_worker);
  const qualityAdjustedCeiling = Math.ceil(demandCeiling * quality_score / 100);
  const max_workers = Math.min(
    demandCeiling,
    qualityAdjustedCeiling,
    policy.max_workers,
    quota_workers,
    healthy_capacity
  );
  if (max_workers < 1) return blocked("NO_ELIGIBLE_CAPACITY");

  return {
    eligible: true,
    reason: null,
    min_workers: Math.min(policy.min_workers, max_workers),
    max_workers
  };
}

/**
 * Uniformly selects an integer from [minimum, maximum] using rejection
 * sampling, avoiding modulo bias. Cloudflare Workers provides Web Crypto.
 */
function secureRandomInt(minimum, maximum) {
  const span = maximum - minimum + 1;
  if (!Number.isSafeInteger(span) || span < 1 || span > MAX_UINT32_RANGE) {
    throw new RangeError("random interval is outside the supported range");
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("a cryptographically secure random source is required");
  }
  const acceptanceLimit = Math.floor(MAX_UINT32_RANGE / span) * span;
  const sample = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(sample);
  } while (sample[0] >= acceptanceLimit);
  return minimum + (sample[0] % span);
}

/**
 * Selects one count from validated bounds. An injectable source keeps tests
 * deterministic; production callers should omit it to use Web Crypto.
 */
export function chooseWorkerCount(bounds, randomInt = secureRandomInt) {
  if (!bounds || typeof bounds !== "object" || typeof bounds.eligible !== "boolean") {
    throw new TypeError("bounds must be a calculated Worker count interval");
  }
  if (!bounds.eligible) return 0;
  assertInteger(bounds.min_workers, "bounds.min_workers", 1);
  assertInteger(bounds.max_workers, "bounds.max_workers", bounds.min_workers);
  if (typeof randomInt !== "function") {
    throw new TypeError("randomInt must be a function");
  }
  const selected = randomInt(bounds.min_workers, bounds.max_workers);
  if (!Number.isSafeInteger(selected) ||
      selected < bounds.min_workers || selected > bounds.max_workers) {
    throw new RangeError("random source returned an out-of-range value");
  }
  return selected;
}
