#include "../src/amphetamin_policy.h"

#include <stddef.h>
#include <stdio.h>

_Static_assert(sizeof(AmphetaminInput) == 64u, "native reference input layout must match ABI v1");
_Static_assert(offsetof(AmphetaminInput, random_u32) == 28u, "native input random offset");
_Static_assert(offsetof(AmphetaminInput, recovery_minutes) == 56u, "native input recovery offset");
_Static_assert(sizeof(AmphetaminDecision) == 20u, "native reference decision layout must match ABI v1");
_Static_assert(offsetof(AmphetaminDecision, activation_remaining_minutes) == 12u, "native decision activation offset");

int main(void) {
    AmphetaminInput input;
    AmphetaminDecision output;
    size_t records = 0u;

    while (fread(&input, sizeof(input), 1u, stdin) == 1u) {
        output = amphetamin_evaluate(&input);
        if (fwrite(&output, sizeof(output), 1u, stdout) != 1u) {
            return 3;
        }
        records++;
    }

    if (ferror(stdin) || records == 0u) {
        return 2;
    }
    return 0;
}
