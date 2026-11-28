#include "amphetamin_policy.h"

#define QUALITY_FLOOR 70u
#define REFILL_THRESHOLD_PERCENT 15u
#define CRITICAL_OVERLOAD_CUTOFF 100u
#define MAXIMUM_DRIVE_THRESHOLD 70u
#define RESOURCE_HUNT_THRESHOLD 85u
#define RECOVERY_OVERLOAD_MAX 40u
#define RECOVERY_PRESSURE_MAX 60u
#define RECOVERY_SCORE_MIN 80u
#define MAX_DEMAND_WORKERS 64u

static AmphetaminDecision decision(AmphetaminMode mode, uint32_t workers,
                                   uint8_t refill, uint8_t capacity,
                                   uint8_t reason, uint32_t activation,
                                   uint8_t multiplier, uint8_t burnout) {
    AmphetaminDecision out;
    out.mode = mode;
    out.worker_count = workers;
    out.request_refill = refill;
    out.request_capacity = capacity;
    out.reason_code = reason;
    out.activation_remaining_minutes = activation;
    out.drive_multiplier_percent = multiplier;
    out.projected_burnout_score = burnout;
    return out;
}

AmphetaminDecision amphetamin_evaluate(const AmphetaminInput *in) {
    uint32_t demand;
    uint32_t demand_workers;
    uint32_t quality_cap;
    uint32_t budget_cap;
    uint32_t upper;
    uint32_t lower;
    uint32_t selected;
    uint32_t activation;
    uint32_t multiplier_bonus;
    uint32_t multiplier;
    uint32_t projected_burnout;
    uint64_t activation_extension;
    uint64_t recovery_steps;
    uint64_t burnout_reduction;

    if (in == 0 || in->quality_score > 100u ||
        in->resource_pressure > 100u || in->overload_score > 100u ||
        in->recovery_score > 100u || in->cooldown_latched > 1u ||
        in->integrity_risk > 1u || in->burnout_score > 100u ||
        in->burnout_recovery_per_hour > 100u ||
        in->max_workers > MAX_DEMAND_WORKERS ||
        (in->new_deployments != 0u &&
         (in->max_activation_minutes == 0u ||
          in->deployment_extension_minutes == 0u)) ||
        (in->max_activation_minutes != 0u &&
         in->activation_remaining_minutes > in->max_activation_minutes) ||
        in->available_credits > in->max_credits) {
        return decision(AMPHETAMIN_BLOCKED, 0u, 0u, 0u, 1u, 0u, 100u, 0u);
    }

    activation = in->activation_remaining_minutes;
    activation_extension = (uint64_t)in->new_deployments *
                           in->deployment_extension_minutes;
    if (in->max_activation_minutes != 0u) {
        uint64_t extended = (uint64_t)activation + activation_extension;
        activation = (uint32_t)(extended > in->max_activation_minutes
                                    ? in->max_activation_minutes : extended);
    }
    recovery_steps = in->recovery_minutes / 60u;
    burnout_reduction = recovery_steps * in->burnout_recovery_per_hour;
    projected_burnout = burnout_reduction >= in->burnout_score
                            ? 0u : (uint32_t)(in->burnout_score - burnout_reduction);
    projected_burnout += (uint64_t)in->new_deployments * in->burnout_per_deploy;
    if (projected_burnout > 100u) projected_burnout = 100u;
    multiplier_bonus = in->deployment_streak >= 5u
                           ? 50u : in->deployment_streak * 10u;
    multiplier = 100u + multiplier_bonus;

    /* Integrity/security failure is the only unconditional hard stop. */
    if (in->integrity_risk != 0u) {
        return decision(AMPHETAMIN_HARD_STOP, 0u, 0u, 0u, 10u, activation, 100u, (uint8_t)projected_burnout);
    }

    /* Cooldown is controller-latched; overload alone does not terminate a deployment chain. */
    if (in->cooldown_latched != 0u &&
        !(in->recovery_score >= RECOVERY_SCORE_MIN &&
          in->overload_score <= RECOVERY_OVERLOAD_MAX &&
          in->resource_pressure <= RECOVERY_PRESSURE_MAX)) {
        return decision(AMPHETAMIN_COOLDOWN, 0u, 0u, 0u, 2u, activation, 100u, (uint8_t)projected_burnout);
    }

    if (in->quality_score < QUALITY_FLOOR) {
        return decision(AMPHETAMIN_BLOCKED, 0u, 0u, 0u, 3u, activation, 100u, (uint8_t)projected_burnout);
    }

    if (in->backlog > UINT32_MAX - in->ambiguous_tasks) {
        demand = UINT32_MAX;
    } else {
        demand = in->backlog + in->ambiguous_tasks;
    }

    /* A live activation window sustains drive even between deployment pulses. */
    if (demand == 0u && activation != 0u) demand = 1u;

    /* Situational activation: no clock or fixed schedule is involved. */
    if (demand == 0u && in->resource_pressure < 70u) {
        return decision(AMPHETAMIN_STANDBY, 0u, 0u, 0u, 0u, activation, (uint8_t)multiplier, (uint8_t)projected_burnout);
    }

    if (in->max_credits == 0u ||
        (uint64_t)in->available_credits * 100u <=
        (uint64_t)in->max_credits * REFILL_THRESHOLD_PERCENT) {
        uint8_t hunt = (uint8_t)(in->resource_pressure >= RESOURCE_HUNT_THRESHOLD ||
                                 in->overload_score >= RESOURCE_HUNT_THRESHOLD);
        return decision(hunt ? AMPHETAMIN_RESOURCE_HUNT : AMPHETAMIN_REFILL,
                        0u, 1u, hunt, 4u, activation, (uint8_t)multiplier, (uint8_t)projected_burnout);
    }

    if (in->max_workers == 0u || in->available_credits == 0u) {
        return decision(AMPHETAMIN_REFILL, 0u, 1u, 0u, 4u, activation, (uint8_t)multiplier, (uint8_t)projected_burnout);
    }

    /* Ambiguity and resource pressure increase demand, but stay quota-bounded. */
    demand_workers = demand;
    if (in->resource_pressure >= 70u && demand_workers < MAX_DEMAND_WORKERS) {
        demand_workers += 1u;
    }
    if (demand_workers > MAX_DEMAND_WORKERS) {
        demand_workers = MAX_DEMAND_WORKERS;
    }

    quality_cap = (uint32_t)(((uint64_t)in->max_workers *
                              in->quality_score) / 100u);
    if (quality_cap == 0u) quality_cap = 1u;

    budget_cap = in->available_credits;
    upper = in->max_workers;
    if (upper > demand_workers) upper = demand_workers;
    if (upper > quality_cap) upper = quality_cap;
    if (upper > budget_cap) upper = budget_cap;

    if (upper == 0u) {
        return decision(AMPHETAMIN_REFILL, 0u, 1u, 0u, 4u, activation, (uint8_t)multiplier, (uint8_t)projected_burnout);
    }

    /* Uniform bounded choice. Host must supply a CSPRNG value. */
    lower = 1u;
    selected = lower + (in->random_u32 % (upper - lower + 1u));
    if (in->resource_pressure >= RESOURCE_HUNT_THRESHOLD ||
        in->overload_score >= RESOURCE_HUNT_THRESHOLD) {
        selected = (uint32_t)(((uint64_t)selected * multiplier + 99u) / 100u);
        if (selected > upper) selected = upper;
        return decision(AMPHETAMIN_RESOURCE_HUNT, selected, 0u, 1u, 7u, activation, (uint8_t)multiplier, (uint8_t)projected_burnout);
    }
    if (in->resource_pressure >= MAXIMUM_DRIVE_THRESHOLD ||
        in->overload_score >= MAXIMUM_DRIVE_THRESHOLD) {
        selected = (uint32_t)(((uint64_t)selected * multiplier + 99u) / 100u);
        if (selected > upper) selected = upper;
        return decision(AMPHETAMIN_MAXIMUM_DRIVE, selected, 0u, 0u, 6u, activation, (uint8_t)multiplier, (uint8_t)projected_burnout);
    }
    selected = (uint32_t)(((uint64_t)selected * multiplier + 99u) / 100u);
    if (selected > upper) selected = upper;
    return decision(AMPHETAMIN_BOOST, selected, 0u, 0u, 5u, activation, (uint8_t)multiplier, (uint8_t)projected_burnout);
}
