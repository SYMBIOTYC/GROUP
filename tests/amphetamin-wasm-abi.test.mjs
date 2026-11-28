import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const wasmPath = process.env.AMPHETAMIN_WASM_PATH;
if (!wasmPath) throw new Error("AMPHETAMIN_WASM_PATH must point to the compiled wasm32 module");

test("wasm32 ABI v1 evaluates a C policy input and returns the expected decision", async () => {
  const bytes = await readFile(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes);
  const { memory, amphetamin_input_ptr, amphetamin_output_ptr, amphetamin_eval } = instance.exports;
  assert.ok(memory instanceof WebAssembly.Memory);
  assert.equal(typeof amphetamin_input_ptr, "function");
  assert.equal(typeof amphetamin_output_ptr, "function");
  assert.equal(typeof amphetamin_eval, "function");

  const input = amphetamin_input_ptr();
  const output = amphetamin_output_ptr();
  const view = new DataView(memory.buffer);

  // ABI v1 AmphetaminInput (64 bytes), little-endian wasm32 layout.
  view.setUint32(input + 0, 3, true);    // backlog
  view.setUint32(input + 4, 0, true);    // ambiguous_tasks
  view.setUint8(input + 8, 0);          // resource_pressure
  view.setUint8(input + 9, 0);          // overload_score
  view.setUint8(input + 10, 100);       // quality_score
  view.setUint8(input + 11, 0);         // cooldown_latched
  view.setUint8(input + 12, 0);         // recovery_score
  view.setUint8(input + 13, 0);         // integrity_risk
  view.setUint32(input + 16, 10, true); // available_credits
  view.setUint32(input + 20, 10, true); // max_credits
  view.setUint32(input + 24, 4, true);  // max_workers
  view.setUint32(input + 28, 0, true);  // random_u32

  assert.equal(amphetamin_eval(), 0);

  // AmphetaminDecision: mode=BOOST(1), workers=1, no refill/capacity request.
  assert.equal(view.getInt32(output + 0, true), 1);
  assert.equal(view.getUint32(output + 4, true), 1);
  assert.equal(view.getUint8(output + 8), 0);
  assert.equal(view.getUint8(output + 9), 0);
  assert.equal(view.getUint8(output + 10), 5); // BOOST reason code
  assert.equal(view.getUint32(output + 12, true), 0);
  assert.equal(view.getUint8(output + 16), 100);
  assert.equal(view.getUint8(output + 17), 0);
});

test("wasm32 ABI v1 fails closed on an invalid policy input", async () => {
  const bytes = await readFile(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes);
  const input = instance.exports.amphetamin_input_ptr();
  const output = instance.exports.amphetamin_output_ptr();
  const view = new DataView(instance.exports.memory.buffer);
  view.setUint8(input + 10, 101); // quality_score is constrained to 0..100
  instance.exports.amphetamin_eval();
  assert.equal(view.getInt32(output, true), 4); // AMPHETAMIN_BLOCKED
  assert.equal(view.getUint32(output + 4, true), 0);
});
