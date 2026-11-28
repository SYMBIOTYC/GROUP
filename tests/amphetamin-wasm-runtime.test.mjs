import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAmphetaminWasmEvaluator } from "../src/amphetamin-wasm-runtime.mjs";

const wasmPath = process.env.AMPHETAMIN_WASM_PATH;
if (!wasmPath) throw new Error("AMPHETAMIN_WASM_PATH must point to the compiled wasm32 module");

const policyInput = {
  backlog: 3, ambiguous_tasks: 0, resource_pressure: 0, overload_score: 0,
  quality_score: 100, cooldown_latched: 0, recovery_score: 0, integrity_risk: 0,
  available_credits: 10, max_credits: 10, max_workers: 4, random_u32: 0,
  activation_remaining_minutes: 0, new_deployments: 0,
  deployment_extension_minutes: 180, max_activation_minutes: 600,
  deployment_streak: 0, burnout_score: 0, burnout_per_deploy: 15,
  recovery_minutes: 0, burnout_recovery_per_hour: 5
};

test("Worker WASM evaluator marshals the complete C input and returns a typed decision", async () => {
  const module = await WebAssembly.compile(await readFile(wasmPath));
  const evaluate = await createAmphetaminWasmEvaluator(module);
  const decision = evaluate(policyInput);
  assert.deepEqual(decision, {
    mode: 1, worker_count: 1, request_refill: 0, request_capacity: 0,
    reason_code: 5, activation_remaining_minutes: 0,
    drive_multiplier_percent: 100, projected_burnout_score: 0
  });
});

test("Worker WASM evaluator rejects missing, out-of-range, and non-integer ABI fields", async () => {
  const module = await WebAssembly.compile(await readFile(wasmPath));
  const evaluate = await createAmphetaminWasmEvaluator(module);
  assert.throws(() => evaluate({ ...policyInput, quality_score: 101 }), /quality_score/);
  assert.throws(() => evaluate({ ...policyInput, random_u32: -1 }), /random_u32/);
  const { random_u32, ...missingRandom } = policyInput;
  assert.throws(() => evaluate(missingRandom), /random_u32/);
  assert.throws(() => evaluate({ ...policyInput, backlog: 1.5 }), /backlog/);
});

