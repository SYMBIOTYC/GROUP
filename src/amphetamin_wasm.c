#include "amphetamin_policy.h"

#include <stddef.h>
#include <stdint.h>

/*
 * Stable wasm32 ABI v1.
 *
 * JavaScript writes the input structure into amphetamin_input_ptr(), calls
 * amphetamin_eval(), then reads AmphetaminDecision at amphetamin_output_ptr().
 * The explicit assertions make compiler/layout drift a build failure.
 */
_Static_assert(sizeof(AmphetaminInput) == 64u, "AMPHETAMIN ABI v1 input size changed");
_Static_assert(offsetof(AmphetaminInput, backlog) == 0u, "ABI input.backlog offset");
_Static_assert(offsetof(AmphetaminInput, ambiguous_tasks) == 4u, "ABI input.ambiguous_tasks offset");
_Static_assert(offsetof(AmphetaminInput, resource_pressure) == 8u, "ABI input.resource_pressure offset");
_Static_assert(offsetof(AmphetaminInput, available_credits) == 16u, "ABI input.available_credits offset");
_Static_assert(offsetof(AmphetaminInput, random_u32) == 28u, "ABI input.random_u32 offset");
_Static_assert(offsetof(AmphetaminInput, activation_remaining_minutes) == 32u, "ABI input.activation_remaining_minutes offset");
_Static_assert(offsetof(AmphetaminInput, deployment_streak) == 48u, "ABI input.deployment_streak offset");
_Static_assert(offsetof(AmphetaminInput, recovery_minutes) == 56u, "ABI input.recovery_minutes offset");
_Static_assert(sizeof(AmphetaminDecision) == 20u, "AMPHETAMIN ABI v1 decision size changed");
_Static_assert(offsetof(AmphetaminDecision, worker_count) == 4u, "ABI decision.worker_count offset");
_Static_assert(offsetof(AmphetaminDecision, activation_remaining_minutes) == 12u, "ABI decision.activation_remaining_minutes offset");
_Static_assert(offsetof(AmphetaminDecision, drive_multiplier_percent) == 16u, "ABI decision.drive_multiplier_percent offset");

static AmphetaminInput wasm_input;
static AmphetaminDecision wasm_output;

__attribute__((visibility("default")))
uint32_t amphetamin_input_ptr(void) {
    return (uint32_t)(uintptr_t)&wasm_input;
}

__attribute__((visibility("default")))
uint32_t amphetamin_output_ptr(void) {
    return (uint32_t)(uintptr_t)&wasm_output;
}

__attribute__((visibility("default")))
int32_t amphetamin_eval(void) {
    wasm_output = amphetamin_evaluate(&wasm_input);
    return 0;
}
