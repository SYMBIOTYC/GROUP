const INPUT_LAYOUT = Object.freeze({
  backlog: ["u32", 0, 0xffffffff],
  ambiguous_tasks: ["u32", 4, 0xffffffff],
  resource_pressure: ["u8", 8, 100],
  overload_score: ["u8", 9, 100],
  quality_score: ["u8", 10, 100],
  cooldown_latched: ["u8", 11, 1],
  recovery_score: ["u8", 12, 100],
  integrity_risk: ["u8", 13, 1],
  available_credits: ["u32", 16, 0xffffffff],
  max_credits: ["u32", 20, 0xffffffff],
  max_workers: ["u32", 24, 0xffffffff],
  random_u32: ["u32", 28, 0xffffffff],
  activation_remaining_minutes: ["u32", 32, 0xffffffff],
  new_deployments: ["u32", 36, 0xffffffff],
  deployment_extension_minutes: ["u32", 40, 0xffffffff],
  max_activation_minutes: ["u32", 44, 0xffffffff],
  deployment_streak: ["u32", 48, 0xffffffff],
  burnout_score: ["u8", 52, 100],
  burnout_per_deploy: ["u8", 53, 100],
  recovery_minutes: ["u32", 56, 0xffffffff],
  burnout_recovery_per_hour: ["u8", 60, 100]
});

const INPUT_SIZE = 64;
const OUTPUT_SIZE = 20;

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("AMPHETAMIN WASM input must be an object");
  }
  for (const [field, [kind, , maximum]] of Object.entries(INPUT_LAYOUT)) {
    const value = input[field];
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum ||
        (kind === "u8" && value > 255)) {
      throw new TypeError(`AMPHETAMIN WASM input.${field} must be an integer in [0, ${maximum}]`);
    }
  }
}

function readDecision(view, pointer) {
  const decision = {
    mode: view.getInt32(pointer, true),
    worker_count: view.getUint32(pointer + 4, true),
    request_refill: view.getUint8(pointer + 8),
    request_capacity: view.getUint8(pointer + 9),
    reason_code: view.getUint8(pointer + 10),
    activation_remaining_minutes: view.getUint32(pointer + 12, true),
    drive_multiplier_percent: view.getUint8(pointer + 16),
    projected_burnout_score: view.getUint8(pointer + 17)
  };
  if (decision.mode < 0 || decision.mode > 7 ||
      decision.request_refill > 1 || decision.request_capacity > 1 ||
      decision.drive_multiplier_percent > 200 ||
      decision.projected_burnout_score > 100) {
    throw new Error("AMPHETAMIN WASM returned an invalid decision structure");
  }
  return decision;
}

/**
 * Creates a synchronous, allocation-free policy evaluator backed by a compiled
 * WebAssembly.Module. The module is instantiated once per Worker isolate.
 */
export async function createAmphetaminWasmEvaluator(wasmModule) {
  if (!(wasmModule instanceof WebAssembly.Module)) {
    throw new TypeError("AMPHETAMIN_POLICY must be a compiled WebAssembly.Module");
  }
  const instance = await WebAssembly.instantiate(wasmModule);
  const { memory, amphetamin_input_ptr, amphetamin_output_ptr, amphetamin_eval } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) ||
      typeof amphetamin_input_ptr !== "function" ||
      typeof amphetamin_output_ptr !== "function" ||
      typeof amphetamin_eval !== "function") {
    throw new TypeError("AMPHETAMIN WASM module does not implement ABI v1 exports");
  }
  const inputPointer = amphetamin_input_ptr();
  const outputPointer = amphetamin_output_ptr();
  if (inputPointer + INPUT_SIZE > memory.buffer.byteLength ||
      outputPointer + OUTPUT_SIZE > memory.buffer.byteLength) {
    throw new RangeError("AMPHETAMIN WASM ABI pointers exceed linear memory");
  }

  return function evaluateAmphetamin(input) {
    validateInput(input);
    const view = new DataView(memory.buffer);
    for (const [field, [kind, offset]] of Object.entries(INPUT_LAYOUT)) {
      if (kind === "u32") view.setUint32(inputPointer + offset, input[field], true);
      else view.setUint8(inputPointer + offset, input[field]);
    }
    const status = amphetamin_eval();
    if (status !== 0) {
      throw new Error(`AMPHETAMIN WASM evaluation failed with status ${status}`);
    }
    return readDecision(view, outputPointer);
  };
}
