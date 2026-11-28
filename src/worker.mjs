import wasmModule from "../build/amphetamin_policy.wasm";
import worker from "./index.mjs";
import { createAmphetaminWasmEvaluator } from "./amphetamin-wasm-runtime.mjs";

let evaluatorPromise;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/activation/evaluate") {
      return worker.fetch(request, env, ctx);
    }

    // Instantiate once on first policy evaluation, not at isolate startup.
    // A broken optional policy artifact must not take health/read-only routes down.
    try {
      evaluatorPromise ??= createAmphetaminWasmEvaluator(wasmModule);
      const evaluator = await evaluatorPromise;
      return worker.fetch(request, {
        ...env,
        AMPHETAMIN_EVALUATOR: evaluator
      }, ctx);
    } catch {
      return worker.fetch(request, {
        ...env,
        AMPHETAMIN_EVALUATOR: null
      }, ctx);
    }
  }
};
