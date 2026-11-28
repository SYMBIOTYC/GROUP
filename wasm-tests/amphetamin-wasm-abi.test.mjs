import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const wasmPath = process.env.AMPHETAMIN_WASM_PATH;
if (!wasmPath) throw new Error("AMPHETAMIN_WASM_PATH must point to the compiled wasm32 module");

test("wasm32 ABI v1 publishes an explicit version before memory is accessed", async () => {
  const bytes = await readFile(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes);
  assert.equal(typeof instance.exports.amphetamin_abi_version, "function");
  assert.equal(instance.exports.amphetamin_abi_version(), 1);
});

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
  view.setUint32(input + 0, 3, true);
  view.setUint32(input + 4, 0, true);
  view.setUint8(input + 8, 0);
  view.setUint8(input + 9, 0);
  view.setUint8(input + 10, 100);
  view.setUint8(input + 11, 0);
  view.setUint8(input + 12, 0);
  view.setUint8(input + 13, 0);
  view.setUint32(input + 16, 10, true);
  view.setUint32(input + 20, 10, true);
  view.setUint32(input + 24, 4, true);
  view.setUint32(input + 28, 0, true);

  assert.equal(amphetamin_eval(), 0);
  assert.equal(view.getInt32(output + 0, true), 1);
  assert.equal(view.getUint32(output + 4, true), 1);
  assert.equal(view.getUint8(output + 8), 0);
  assert.equal(view.getUint8(output + 9), 0);
  assert.equal(view.getUint8(output + 10), 5);
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
  view.setUint8(input + 10, 101);
  instance.exports.amphetamin_eval();
  assert.equal(view.getInt32(output, true), 4);
  assert.equal(view.getUint32(output + 4, true), 0);
});
