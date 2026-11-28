import test from "node:test";
import assert from "node:assert/strict";
import { applyActivationEvent, transitionActivationState } from "../src/amphetamin-state.mjs";

const policy = {
  deployment_extension_minutes: 180,
  max_activation_minutes: 600,
  burnout_per_deploy: 15,
  burnout_recovery_per_hour: 5
};

test("a deployment pulse extends the persisted activation window and increases drive", () => {
  const result = transitionActivationState({
    activation_remaining_minutes: 90,
    deployment_streak: 2,
    burnout_score: 20,
    recovery_remainder_minutes: 0,
    updated_at: "2026-11-28T10:00:00.000Z",
    version: 4
  }, { type: "deployment", occurred_at: "2026-11-28T10:30:00.000Z" }, policy);

  assert.equal(result.activation_remaining_minutes, 240);
  assert.equal(result.deployment_streak, 3);
  assert.equal(result.drive_multiplier_percent, 130);
  assert.equal(result.burnout_score, 35);
  assert.equal(result.version, 5);
});

test("elapsed time decays activation and accumulates fractional recovery across ticks", () => {
  const result = transitionActivationState({
    activation_remaining_minutes: 120,
    deployment_streak: 3,
    burnout_score: 20,
    recovery_remainder_minutes: 0,
    updated_at: "2026-11-28T08:00:00.000Z",
    version: 7
  }, { type: "tick", occurred_at: "2026-11-28T08:45:00.000Z" }, policy);

  assert.equal(result.activation_remaining_minutes, 75);
  assert.equal(result.burnout_score, 20);
  assert.equal(result.recovery_remainder_minutes, 45);
  assert.equal(result.version, 8);
});

test("recovery remainder combines across ticks and resets when burnout reaches zero", () => {
  const first = transitionActivationState({
    activation_remaining_minutes: 0, deployment_streak: 0, burnout_score: 20,
    recovery_remainder_minutes: 45, updated_at: "2026-11-28T08:00:00.000Z", version: 1
  }, { type: "tick", occurred_at: "2026-11-28T08:30:00.000Z" }, policy);
  assert.equal(first.burnout_score, 15);
  assert.equal(first.recovery_remainder_minutes, 15);

  const second = transitionActivationState(first, {
    type: "tick", occurred_at: "2026-11-28T11:15:00.000Z"
  }, policy);
  assert.equal(second.burnout_score, 0);
  assert.equal(second.recovery_remainder_minutes, 0);
});

test("deployment after activation expires starts a fresh deployment streak", () => {
  const result = transitionActivationState({
    activation_remaining_minutes: 10, deployment_streak: 5, burnout_score: 0,
    recovery_remainder_minutes: 0, updated_at: "2026-11-28T08:00:00.000Z", version: 1
  }, { type: "deployment", occurred_at: "2026-11-28T09:00:00.000Z" }, policy);
  assert.equal(result.activation_remaining_minutes, 180);
  assert.equal(result.deployment_streak, 1);
  assert.equal(result.drive_multiplier_percent, 110);
});

test("rejects invalid state, event types, timestamps, and policy", () => {
  const state = {
    activation_remaining_minutes: 0, deployment_streak: 0, burnout_score: 0,
    recovery_remainder_minutes: 0, updated_at: "2026-11-28T08:00:00.000Z", version: 0
  };
  assert.throws(() => transitionActivationState(state, {
    type: "other", occurred_at: "2026-11-28T08:01:00.000Z"
  }, policy), /event.type/);
});

test("activation batch rejects an event mark when the state CAS did not update", async () => {
  const state = {
    activation_remaining_minutes: 0,
    deployment_streak: 0,
    burnout_score: 0,
    recovery_remainder_minutes: 0,
    updated_at: "2026-11-28T10:00:00.000Z",
    version: 0
  };
  const event = {
    event_type: "deployment",
    occurred_at: "2026-11-28T10:00:00.000Z",
    applied_at: null
  };
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            run: async () => ({ meta: { changes: 1 } }),
            first: async () => sql.includes("amphetamin_activation_events") ? event : state
          };
        }
      };
    },
    batch: async () => [{ meta: { changes: 1 } }, { meta: { changes: 0 } }]
  };

  await assert.rejects(
    () => applyActivationEvent(db, "tenant-a", "project-a", "deploy-event-0001", "deployment"),
    error => error.code === "ACTIVATION_EVENT_COMMIT_INCONSISTENT"
  );
});
