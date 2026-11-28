import wasmModule from "../build/amphetamin_policy.wasm";
import worker from "./index.mjs";
import { createAmphetaminWasmEvaluator } from "./amphetamin-wasm-runtime.mjs";
import { runActivationTickSweep } from "./amphetamin-controller.mjs";

let evaluatorPromise;

export default {
  async scheduled(controller, env) {
    const result = await runActivationTickSweep(env?.DB, controller?.scheduledTime);
    console.log(JSON.stringify({
      event: "amphetamin_activation_tick_sweep",
      scheduled_at: result.scheduled_at,
      processed: result.processed,
      replayed: result.replayed
    }));
  },

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
