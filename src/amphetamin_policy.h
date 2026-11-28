#ifndef SYMBIOTYC_AMPHETAMIN_POLICY_H
#define SYMBIOTYC_AMPHETAMIN_POLICY_H

#include <stdint.h>

typedef enum {
    AMPHETAMIN_STANDBY = 0,
    AMPHETAMIN_BOOST,
    AMPHETAMIN_REFILL,
    AMPHETAMIN_COOLDOWN,
    AMPHETAMIN_BLOCKED,
    AMPHETAMIN_MAXIMUM_DRIVE,
    AMPHETAMIN_RESOURCE_HUNT,
    AMPHETAMIN_HARD_STOP
} AmphetaminMode;

typedef struct {
    uint32_t backlog;
    uint32_t ambiguous_tasks;
    uint8_t resource_pressure; /* 0..100: token/API/CPU/memory pressure */
    uint8_t overload_score;    /* 0..100: burn/overdose risk */
    uint8_t quality_score;     /* 0..100: release quality */
    uint8_t cooldown_latched;  /* 1 while an external controller holds cooldown */
    uint8_t recovery_score;    /* 0..100: telemetry-backed recovery confidence */
    uint8_t integrity_risk;    /* 1: trusted controller reports integrity/security risk */
    uint32_t available_credits;
    uint32_t max_credits;
    uint32_t max_workers;
    uint32_t random_u32;       /* supplied by a cryptographically secure host RNG */
    uint32_t activation_remaining_minutes; /* state carried by GROUP controller */
    uint32_t new_deployments;  /* deployment pulses since prior policy evaluation */
    uint32_t deployment_extension_minutes;
    uint32_t max_activation_minutes;
    uint32_t deployment_streak; /* consecutive deployments in current activation chain */
    uint8_t burnout_score;     /* 0..100 accumulated fatigue telemetry */
    uint8_t burnout_per_deploy;
    uint32_t recovery_minutes;
    uint8_t burnout_recovery_per_hour;
} AmphetaminInput;

typedef struct {
    AmphetaminMode mode;
    uint32_t worker_count;
    uint8_t request_refill;
    uint8_t request_capacity;
    uint8_t reason_code;
    uint32_t activation_remaining_minutes;
    uint8_t drive_multiplier_percent;
    uint8_t projected_burnout_score;
} AmphetaminDecision;

/* Pure policy evaluation; performs no I/O, provisioning, or secret handling. */
AmphetaminDecision amphetamin_evaluate(const AmphetaminInput *input);

#endif
