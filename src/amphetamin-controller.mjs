import {
  AMPHETAMIN_ACTIVATION_POLICY,
  getActivationState,
  validateActivationState
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
