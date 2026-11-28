import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAmphetaminForProject } from "../src/amphetamin-controller.mjs";

function stateDb(row) {
  const queries = [];
  return {
    queries,
    prepare(sql) {
      queries.push(sql);
      return {
        bind(...values) {
          assert.deepEqual(values, ["tenant-a", "project-a"]);
          return { first: async () => row };
        }
      };
    }
  };
}

const persisted = {
  activation_remaining_minutes: 245,
  deployment_streak: 3,
  burnout_score: 45,
  recovery_remainder_minutes: 20,
  updated_at: "2026-11-28T10:00:00.000Z",
  version: 9
};

const baseInput = {
  backlog: 4,
  ambiguous_tasks: 1,
  resource_pressure: 72,
  overload_score: 35,
  quality_score: 95,
  cooldown_latched: 0,
  recovery_score: 90,
  integrity_risk: 0,
  available_credits: 20,
  max_credits: 100,
  max_workers: 8,
  random_u32: 123
};

test("controller hydrates C policy inputs from durable state without reapplying events", async () => {
  const db = stateDb(persisted);
  let captured;
  const result = await evaluateAmphetaminForProject(
    db, "tenant-a", "project-a", baseInput,
    input => {
      captured = input;
      return { mode: 5, worker_count: 4, activation_remaining_minutes: input.activation_remaining_minutes,
        drive_multiplier_percent: 130, projected_burnout_score: input.burnout_score };
    },
    "2026-11-28T10:05:00.000Z"
  );

  assert.equal(captured.activation_remaining_minutes, 245);
  assert.equal(captured.deployment_streak, 3);
  assert.equal(captured.burnout_score, 45);
  assert.equal(captured.new_deployments, 0);
  assert.equal(captured.recovery_minutes, 0);
  assert.equal(captured.deployment_extension_minutes, 180);
  assert.equal(captured.max_activation_minutes, 600);
  assert.equal(captured.burnout_per_deploy, 15);
  assert.equal(captured.burnout_recovery_per_hour, 5);
  assert.equal(result.activation_state.version, 9);
  assert.equal(result.decision.worker_count, 4);
  assert.equal(db.queries.length, 1);
});

test("controller uses a zeroed initial state when the project has no activation row", async () => {
  const db = stateDb(null);
  let captured;
  const result = await evaluateAmphetaminForProject(
    db, "tenant-a", "project-a", baseInput,
    input => { captured = input; return { mode: 0, worker_count: 0 }; },
    "2026-11-28T10:05:00.000Z"
  );
  assert.equal(captured.activation_remaining_minutes, 0);
  assert.equal(captured.deployment_streak, 0);
  assert.equal(captured.burnout_score, 0);
  assert.equal(captured.new_deployments, 0);
  assert.equal(result.activation_state.version, 0);
});

test("controller rejects malformed persisted state and never invokes the evaluator", async () => {
  const db = stateDb({ ...persisted, burnout_score: 101 });
  let invoked = false;
  await assert.rejects(
    evaluateAmphetaminForProject(db, "tenant-a", "project-a", baseInput,
      () => { invoked = true; return {}; }, "2026-11-28T10:05:00.000Z"),
    /state.burnout_score/
  );
  assert.equal(invoked, false);
});

test("controller refuses missing evaluator and invalid base policy input", async () => {
  const db = stateDb(persisted);
  await assert.rejects(
    evaluateAmphetaminForProject(db, "tenant-a", "project-a", baseInput, null),
    /evaluator/
  );
  await assert.rejects(
    evaluateAmphetaminForProject(db, "tenant-a", "project-a", { ...baseInput, backlog: -1 },
      () => ({})),
    /input.backlog/
  );
});
