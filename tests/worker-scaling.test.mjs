import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateWorkerCountBounds,
  chooseWorkerCount
} from "../src/worker-scaling.mjs";

const policy = {
  min_quality_score: 80,
  demand_units_per_worker: 10,
  min_workers: 1,
  max_workers: 20
};

test("blocks scale-up when mandatory quality gates fail", () => {
  const result = calculateWorkerCountBounds({
    quality_score: 99,
    quality_gate_passed: false,
    demand_units: 100,
    quota_workers: 20,
    healthy_capacity: 20,
    policy
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "QUALITY_GATE_FAILED");
  assert.equal(result.min_workers, 0);
  assert.equal(result.max_workers, 0);
});

test("blocks scale-up when release quality is below the policy floor", () => {
  const result = calculateWorkerCountBounds({
    quality_score: 79,
    quality_gate_passed: true,
    demand_units: 100,
    quota_workers: 20,
    healthy_capacity: 20,
    policy
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "QUALITY_BELOW_POLICY");
});

test("derives a bounded interval from quality and normalized demand", () => {
  const result = calculateWorkerCountBounds({
    quality_score: 90,
    quality_gate_passed: true,
    demand_units: 100,
    quota_workers: 12,
    healthy_capacity: 9,
    policy
  });
  assert.equal(result.eligible, true);
  assert.equal(result.min_workers, 1);
  assert.equal(result.max_workers, 9);
});

test("increasing quality or demand never widens the interval downward", () => {
  const low = calculateWorkerCountBounds({
    quality_score: 80, quality_gate_passed: true, demand_units: 50,
    quota_workers: 20, healthy_capacity: 20, policy
  });
  const higherQuality = calculateWorkerCountBounds({
    quality_score: 100, quality_gate_passed: true, demand_units: 50,
    quota_workers: 20, healthy_capacity: 20, policy
  });
  const higherDemand = calculateWorkerCountBounds({
    quality_score: 80, quality_gate_passed: true, demand_units: 100,
    quota_workers: 20, healthy_capacity: 20, policy
  });
  assert.ok(higherQuality.max_workers >= low.max_workers);
  assert.ok(higherDemand.max_workers >= low.max_workers);
});

test("never exceeds quota, healthy capacity, or policy maximum", () => {
  const result = calculateWorkerCountBounds({
    quality_score: 100, quality_gate_passed: true, demand_units: 1000,
    quota_workers: 4, healthy_capacity: 3, policy
  });
  assert.equal(result.max_workers, 3);
});

test("returns zero capacity when healthy capacity is below the configured minimum", () => {
  const result = calculateWorkerCountBounds({
    quality_score: 100, quality_gate_passed: true, demand_units: 100,
    quota_workers: 20, healthy_capacity: 0, policy
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "NO_ELIGIBLE_CAPACITY");
});

test("selects an integer inside the inclusive interval", () => {
  const bounds = { eligible: true, min_workers: 2, max_workers: 7 };
  assert.equal(chooseWorkerCount(bounds, () => 2), 2);
  assert.equal(chooseWorkerCount(bounds, () => 7), 7);
  assert.equal(chooseWorkerCount(bounds, () => 4), 4);
});

test("rejects a random source that returns a value outside the interval", () => {
  assert.throws(
    () => chooseWorkerCount({ eligible: true, min_workers: 2, max_workers: 7 }, () => 8),
    /random source returned an out-of-range value/
  );
});

test("validates quality, demand, quota, capacity, and policy bounds", () => {
  assert.throws(() => calculateWorkerCountBounds({
    quality_score: 101, quality_gate_passed: true, demand_units: 10,
    quota_workers: 2, healthy_capacity: 2, policy
  }), /quality_score/);
  assert.throws(() => calculateWorkerCountBounds({
    quality_score: 90, quality_gate_passed: true, demand_units: 0,
    quota_workers: 2, healthy_capacity: 2, policy
  }), /demand_units/);
});
