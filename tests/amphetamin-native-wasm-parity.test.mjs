import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createAmphetaminWasmEvaluator } from "../src/amphetamin-wasm-runtime.mjs";

const wasmPath = process.env.AMPHETAMIN_WASM_PATH;
const nativePath = process.env.AMPHETAMIN_NATIVE_EVALUATOR;
if (!wasmPath) throw new Error("AMPHETAMIN_WASM_PATH must point to the compiled wasm32 module");
if (!nativePath) throw new Error("AMPHETAMIN_NATIVE_EVALUATOR must point to the native C reference evaluator");

const base = {
  backlog: 0, ambiguous_tasks: 0, resource_pressure: 0, overload_score: 0,
  quality_score: 100, cooldown_latched: 0, recovery_score: 0, integrity_risk: 0,
  available_credits: 100, max_credits: 100, max_workers: 16, random_u32: 0,
  activation_remaining_minutes: 0, new_deployments: 0,
  deployment_extension_minutes: 180, max_activation_minutes: 600,
  deployment_streak: 0, burnout_score: 0, burnout_per_deploy: 15,
  recovery_minutes: 0, burnout_recovery_per_hour: 5
};

const vectors = [
  ["standby", {}],
  ["bounded boost", { backlog: 40, ambiguous_tasks: 8, random_u32: 7 }],
  ["refill threshold", { backlog: 12, available_credits: 15 }],
  ["resource hunt", { backlog: 100, resource_pressure: 100, overload_score: 100 }],
  ["quality floor blocks", { backlog: 20, quality_score: 69 }],
  ["latched cooldown", { backlog: 8, cooldown_latched: 1, recovery_score: 79 }],
  ["recovery releases cooldown", { backlog: 8, cooldown_latched: 1, recovery_score: 90, overload_score: 20, resource_pressure: 30 }],
  ["maximum drive", { backlog: 40, resource_pressure: 75, overload_score: 75 }],
  ["integrity hard stop", { backlog: 100, integrity_risk: 1 }],
  ["deployment activation and burnout", {
    backlog: 40, activation_remaining_minutes: 90, new_deployments: 2,
    deployment_streak: 2, burnout_score: 20
  }],
  ["activation and burnout caps", {
    backlog: 40, activation_remaining_minutes: 590, new_deployments: 3,
    deployment_streak: 8, burnout_score: 80, recovery_minutes: 240,
    burnout_recovery_per_hour: 10
  }],
  ["uint32 saturation", {
    backlog: 40, activation_remaining_minutes: 10, new_deployments: 0xffffffff,
    deployment_extension_minutes: 0xffffffff, deployment_streak: 4,
    burnout_score: 100, burnout_per_deploy: 100
  }],
  ["demand addition overflow", { backlog: 0xffffffff, ambiguous_tasks: 1 }],
  ["maximum accepted worker cap", { backlog: 64, max_workers: 64, random_u32: 0xffffffff }]
];

function encodeInput(input) {
  const buffer = Buffer.alloc(64);
  const u32 = ["backlog", "ambiguous_tasks", "available_credits", "max_credits",
    "max_workers", "random_u32", "activation_remaining_minutes", "new_deployments",
    "deployment_extension_minutes", "max_activation_minutes", "deployment_streak",
    "recovery_minutes"];
  const offsets = [0, 4, 16, 20, 24, 28, 32, 36, 40, 44, 48, 56];
  u32.forEach((field, index) => buffer.writeUInt32LE(input[field], offsets[index]));
  const u8 = ["resource_pressure", "overload_score", "quality_score", "cooldown_latched",
    "recovery_score", "integrity_risk", "burnout_score", "burnout_per_deploy",
    "burnout_recovery_per_hour"];
  const byteOffsets = [8, 9, 10, 11, 12, 13, 52, 53, 60];
  u8.forEach((field, index) => buffer.writeUInt8(input[field], byteOffsets[index]));
  return buffer;
}

function decodeNativeDecision(buffer) {
  assert.equal(buffer.length, 20, "native C decision must use ABI v1 20-byte layout");
  return {
    mode: buffer.readInt32LE(0),
    worker_count: buffer.readUInt32LE(4),
    request_refill: buffer.readUInt8(8),
    request_capacity: buffer.readUInt8(9),
    reason_code: buffer.readUInt8(10),
    activation_remaining_minutes: buffer.readUInt32LE(12),
    drive_multiplier_percent: buffer.readUInt8(16),
    projected_burnout_score: buffer.readUInt8(17)
  };
}

test("native C and Worker WASM evaluators return identical decisions for policy vectors", async () => {
  const module = await WebAssembly.compile(await readFile(wasmPath));
  const wasmEvaluate = await createAmphetaminWasmEvaluator(module);
  for (const [name, overrides] of vectors) {
    const input = { ...base, ...overrides };
    const native = decodeNativeDecision(execFileSync(nativePath, { input: encodeInput(input) }));
    assert.deepEqual(wasmEvaluate(input), native, `native/WASM mismatch: ${name}`);
  }
});
