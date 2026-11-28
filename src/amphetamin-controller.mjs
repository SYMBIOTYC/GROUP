import {
  AMPHETAMIN_ACTIVATION_POLICY,
  getActivationState,
  validateActivationState,
  applyActivationEvent
} from "./amphetamin-state.mjs";

const UINT32_MAX = 0xffff_ffff;

const INPUT_FIELDS = Object.freeze({
  backlog: [0, UINT32_MAX],
  ambiguous_tasks: [0, UINT32_MAX],
  resource_pressure: [0, 100],
  overload_score: [0, 100],
  quality_score: [0, 100],
  cooldown_latched: [0, 1],
  recovery_score: [0, 100],
  integrity_risk: [0, 1],
  available_credits: [0, UINT32_MAX],
  max_credits: [0, UINT32_MAX],
  max_workers: [0, UINT32_MAX],
  random_u32: [0, UINT32_MAX]
});

function validateBaseInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("input must be an object");
  }
  for (const [name, [minimum, maximum]] of Object.entries(INPUT_FIELDS)) {
    const value = input[name];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new TypeError(`input.${name} must be an integer in [${minimum}, ${maximum}]`);
    }
  }
}

function validateEvaluator(evaluator) {
  if (typeof evaluator !== "function") {
    throw new TypeError("evaluator must be a function backed by the GROUP C policy runtime");
  }
}

/**
 * Hydrates the pure C11 policy input from GROUP's durable tenant/project state.
 *
 * Deployment pulses and elapsed-time recovery have already been committed to
 * D1 by applyActivationEvent. Therefore this evaluation deliberately supplies
 * zero new deployments and zero recovery minutes, preventing double counting.
 * The C evaluator remains an injected host binding; this module does not
 * pretend to compile or execute native C inside the Worker.
 */
export async function evaluateAmphetaminForProject(
  db,
  tenantId,
  projectId,
  baseInput,
  evaluator,
  now
) {
  validateBaseInput(baseInput);
  validateEvaluator(evaluator);
  const state = await getActivationState(db, tenantId, projectId, now);
  validateActivationState(state);

  const policyInput = {
    ...baseInput,
    activation_remaining_minutes: state.activation_remaining_minutes,
    new_deployments: 0,
    deployment_extension_minutes: AMPHETAMIN_ACTIVATION_POLICY.deployment_extension_minutes,
    max_activation_minutes: AMPHETAMIN_ACTIVATION_POLICY.max_activation_minutes,
    deployment_streak: state.deployment_streak,
    burnout_score: state.burnout_score,
    burnout_per_deploy: AMPHETAMIN_ACTIVATION_POLICY.burnout_per_deploy,
    recovery_minutes: 0,
    burnout_recovery_per_hour: AMPHETAMIN_ACTIVATION_POLICY.burnout_recovery_per_hour
  };

  const decision = evaluator(policyInput);
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new TypeError("evaluator must return an AMPHETAMIN decision object");
  }
  return { decision, activation_state: state };
}


const ACTIVATION_TICK_PAGE_SIZE = 100;

/**
 * Applies one idempotent GROUP-owned recovery tick to every active
 * tenant/project activation row. The scheduled timestamp and event ID are
 * derived only from Cloudflare's trusted ScheduledController value.
 *
 * Keyset pagination prevents rows that become inactive during the sweep from
 * shifting the next page. A failed invocation can safely retry the same
 * scheduled minute because each project uses the same event ID.
 */
export async function runActivationTickSweep(
  db,
  scheduledTime,
  applyEvent = applyActivationEvent
) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("db must provide D1 prepare()");
  }
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) {
    throw new TypeError("scheduledTime must be a non-negative safe integer");
  }
  if (typeof applyEvent !== "function") {
    throw new TypeError("applyEvent must be a function");
  }

  const minute = Math.floor(scheduledTime / 60_000);
  const eventId = `tick:${minute}`;
  const scheduledAt = new Date(minute * 60_000).toISOString();
  let afterTenantId = "";
  let afterProjectId = "";
  let processed = 0;
  let replayed = 0;

  while (true) {
    const page = await db.prepare(
      "SELECT tenant_id, project_id FROM amphetamin_activation_state " +
      "WHERE (activation_remaining_minutes > 0 OR deployment_streak > 0 OR " +
      "burnout_score > 0 OR recovery_remainder_minutes > 0) " +
      "AND (tenant_id > ? OR (tenant_id = ? AND project_id > ?)) " +
      "ORDER BY tenant_id ASC, project_id ASC LIMIT ?"
    ).bind(afterTenantId, afterTenantId, afterProjectId, ACTIVATION_TICK_PAGE_SIZE).all();

    if (!Array.isArray(page?.results)) {
      throw new Error("D1 activation tick query returned an invalid result");
    }
    if (page.results.length === 0) break;

    for (const row of page.results) {
      if (typeof row?.tenant_id !== "string" || row.tenant_id.length < 1 ||
          typeof row?.project_id !== "string" || row.project_id.length < 1) {
        throw new Error("D1 activation tick query returned an invalid tenant/project row");
      }
      const result = await applyEvent(
        db, row.tenant_id, row.project_id, eventId, "tick", scheduledAt
      );
      if (result?.replayed === true) replayed += 1;
      processed += 1;
      afterTenantId = row.tenant_id;
      afterProjectId = row.project_id;
    }

    if (page.results.length < ACTIVATION_TICK_PAGE_SIZE) break;
  }

  return { event_id: eventId, scheduled_at: scheduledAt, processed, replayed };
}
