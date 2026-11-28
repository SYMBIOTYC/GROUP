const POLICY = Object.freeze({
  deployment_extension_minutes: 180,
  max_activation_minutes: 600,
  burnout_per_deploy: 15,
  burnout_recovery_per_hour: 5
});

function integer(value, name, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer in [${min}, ${max}]`);
  }
}

function timestamp(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be a valid timestamp`);
  }
  return Date.parse(value);
}

function validateState(state) {
  if (!state || typeof state !== "object") throw new TypeError("state must be an object");
  integer(state.activation_remaining_minutes, "state.activation_remaining_minutes", 0, 600);
  integer(state.deployment_streak, "state.deployment_streak", 0, 5);
  integer(state.burnout_score, "state.burnout_score", 0, 100);
  integer(state.recovery_remainder_minutes, "state.recovery_remainder_minutes", 0, 59);
  integer(state.version, "state.version", 0);
  timestamp(state.updated_at, "state.updated_at");
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== "object") throw new TypeError("policy must be an object");
  integer(policy.deployment_extension_minutes, "policy.deployment_extension_minutes", 1, 600);
  integer(policy.max_activation_minutes, "policy.max_activation_minutes", 1, 600);
  integer(policy.burnout_per_deploy, "policy.burnout_per_deploy", 0, 100);
  integer(policy.burnout_recovery_per_hour, "policy.burnout_recovery_per_hour", 0, 100);
}

export function transitionActivationState(state, event, policy = POLICY) {
  validateState(state);
  validatePolicy(policy);
  if (!event || !["deployment", "tick"].includes(event.type)) {
    throw new TypeError("event.type must be deployment or tick");
  }
  const previousTime = timestamp(state.updated_at, "state.updated_at");
  const eventTime = timestamp(event.occurred_at, "event.occurred_at");
  const elapsedMinutes = Math.max(0, Math.floor((eventTime - previousTime) / 60000));

  let activation = Math.max(0, state.activation_remaining_minutes - elapsedMinutes);
  let streak = activation === 0 ? 0 : state.deployment_streak;

  const recoveredMinutes = state.recovery_remainder_minutes + elapsedMinutes;
  const recoveryHours = Math.floor(recoveredMinutes / 60);
  let burnout = Math.max(0, state.burnout_score - recoveryHours * policy.burnout_recovery_per_hour);
  let recoveryRemainder = burnout === 0 ? 0 : recoveredMinutes % 60;

  if (event.type === "deployment") {
    activation = Math.min(
      policy.max_activation_minutes,
      activation + policy.deployment_extension_minutes
    );
    streak = Math.min(5, streak + 1);
    burnout = Math.min(100, burnout + policy.burnout_per_deploy);
  }

  return {
    activation_remaining_minutes: activation,
    deployment_streak: streak,
    drive_multiplier_percent: 100 + streak * 10,
    burnout_score: burnout,
    recovery_remainder_minutes: recoveryRemainder,
    updated_at: new Date(Math.max(previousTime, eventTime)).toISOString(),
    version: state.version + 1
  };
}

function validateScope(tenantId, projectId) {
  if (typeof tenantId !== "string" || tenantId.length < 1 || tenantId.length > 128 ||
      typeof projectId !== "string" || projectId.length < 1 || projectId.length > 128) {
    throw new TypeError("tenant_id and project_id must be bounded non-empty strings");
  }
}

function mapRow(row) {
  return {
    activation_remaining_minutes: row.activation_remaining_minutes,
    deployment_streak: row.deployment_streak,
    drive_multiplier_percent: 100 + row.deployment_streak * 10,
    burnout_score: row.burnout_score,
    recovery_remainder_minutes: row.recovery_remainder_minutes,
    updated_at: row.updated_at,
    version: row.version
  };
}

export async function getActivationState(db, tenantId, projectId, now = new Date().toISOString()) {
  validateScope(tenantId, projectId);
  await db.prepare(
    "INSERT OR IGNORE INTO amphetamin_activation_state (tenant_id, project_id, updated_at) VALUES (?, ?, ?)"
  ).bind(tenantId, projectId, now).run();
  const row = await db.prepare(
    "SELECT activation_remaining_minutes, deployment_streak, burnout_score, recovery_remainder_minutes, updated_at, version FROM amphetamin_activation_state WHERE tenant_id = ? AND project_id = ?"
  ).bind(tenantId, projectId).first();
  if (!row) throw new Error("activation state could not be initialized");
  return mapRow(row);
}

/**
 * Applies a trusted, server-timestamped event exactly once. Optimistic version
 * checks make concurrent distinct events retry against the latest durable row.
 */
export async function applyActivationEvent(db, tenantId, projectId, eventId, eventType, now = new Date().toISOString()) {
  validateScope(tenantId, projectId);
  if (typeof eventId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(eventId)) {
    throw new TypeError("event_id must be 8-128 safe characters");
  }
  if (!["deployment", "tick"].includes(eventType)) {
    throw new TypeError("event_type must be deployment or tick");
  }
  timestamp(now, "now");

  await db.prepare(
    "INSERT OR IGNORE INTO amphetamin_activation_state (tenant_id, project_id, updated_at) VALUES (?, ?, ?)"
  ).bind(tenantId, projectId, now).run();
  await db.prepare(
    "INSERT OR IGNORE INTO amphetamin_activation_events (tenant_id, project_id, event_id, event_type, occurred_at, applied_at) VALUES (?, ?, ?, ?, ?, NULL)"
  ).bind(tenantId, projectId, eventId, eventType, now).run();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const event = await db.prepare(
      "SELECT event_type, occurred_at, applied_at FROM amphetamin_activation_events WHERE tenant_id = ? AND project_id = ? AND event_id = ?"
    ).bind(tenantId, projectId, eventId).first();
    if (!event) throw new Error("activation event could not be read");
    if (event.event_type !== eventType) {
      const error = new Error("event_id was already used for a different activation event");
      error.code = "ACTIVATION_EVENT_CONFLICT";
      throw error;
    }

    const row = await db.prepare(
      "SELECT activation_remaining_minutes, deployment_streak, burnout_score, recovery_remainder_minutes, updated_at, version FROM amphetamin_activation_state WHERE tenant_id = ? AND project_id = ?"
    ).bind(tenantId, projectId).first();
    if (!row) throw new Error("activation state could not be read");

    if (event.applied_at !== null) {
      return { ...mapRow(row), replayed: true };
    }

    const next = transitionActivationState(mapRow(row), {
      type: eventType,
      occurred_at: event.occurred_at
    });
    const batch = await db.batch([
      db.prepare(
        "UPDATE amphetamin_activation_state SET activation_remaining_minutes = ?, deployment_streak = ?, burnout_score = ?, recovery_remainder_minutes = ?, updated_at = ?, version = version + 1 WHERE tenant_id = ? AND project_id = ? AND version = ? AND EXISTS (SELECT 1 FROM amphetamin_activation_events WHERE tenant_id = ? AND project_id = ? AND event_id = ? AND applied_at IS NULL)"
      ).bind(next.activation_remaining_minutes, next.deployment_streak, next.burnout_score,
        next.recovery_remainder_minutes, next.updated_at, tenantId, projectId, row.version,
        tenantId, projectId, eventId),
      db.prepare(
        "UPDATE amphetamin_activation_events SET applied_at = ? WHERE tenant_id = ? AND project_id = ? AND event_id = ? AND applied_at IS NULL AND changes() = 1"
      ).bind(now, tenantId, projectId, eventId)
    ]);
    if ((batch[0]?.meta?.changes ?? 0) === 1) {
      const saved = await db.prepare(
        "SELECT activation_remaining_minutes, deployment_streak, burnout_score, recovery_remainder_minutes, updated_at, version FROM amphetamin_activation_state WHERE tenant_id = ? AND project_id = ?"
      ).bind(tenantId, projectId).first();
      if (!saved) throw new Error("activation state could not be read after commit");
      return { ...mapRow(saved), replayed: false };
    }
  }
  const error = new Error("activation state changed too frequently; retry with the same event_id");
  error.code = "ACTIVATION_STATE_CONTENTION";
  throw error;
}

export const AMPHETAMIN_ACTIVATION_POLICY = POLICY;
