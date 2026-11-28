import wasmModule from "../build/amphetamin_policy.wasm";
import worker from "./index.mjs";
import { createAmphetaminWasmEvaluator } from "./amphetamin-wasm-runtime.mjs";

// Instantiate once per isolate; every request shares the pure policy instance.
// The evaluator owns only in-memory policy buffers and performs no I/O.
const evaluator = await createAmphetaminWasmEvaluator(wasmModule);

export default {
  fetch(request, env, ctx) {
    return worker.fetch(request, {
      ...env,
      AMPHETAMIN_EVALUATOR: evaluator
    }, ctx);
  }
};
