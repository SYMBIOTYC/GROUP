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
                                   uint8_t reason) {
    AmphetaminDecision out;
    out.mode = mode;
    out.worker_count = workers;
    out.request_refill = refill;
    out.request_capacity = capacity;
    out.reason_code = reason;
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

    if (in == 0 || in->quality_score > 100u ||
        in->resource_pressure > 100u || in->overload_score > 100u ||
        in->recovery_score > 100u || in->cooldown_latched > 1u ||
        in->integrity_risk > 1u ||
        in->max_workers > MAX_DEMAND_WORKERS ||
        in->available_credits > in->max_credits) {
        return decision(AMPHETAMIN_BLOCKED, 0u, 0u, 0u, 1u);
    }

    /* Integrity/security failure is the only unconditional hard stop. */
    if (in->integrity_risk != 0u) {
        return decision(AMPHETAMIN_HARD_STOP, 0u, 0u, 0u, 10u);
    }

    /* Latched Cooldown requires externally verified recovery; critical saturation trips it. */
    if (in->overload_score >= CRITICAL_OVERLOAD_CUTOFF ||
        (in->cooldown_latched != 0u &&
         !(in->recovery_score >= RECOVERY_SCORE_MIN &&
           in->overload_score <= RECOVERY_OVERLOAD_MAX &&
           in->resource_pressure <= RECOVERY_PRESSURE_MAX))) {
        return decision(AMPHETAMIN_COOLDOWN, 0u, 0u, 0u, 2u);
    }

    if (in->quality_score < QUALITY_FLOOR) {
        return decision(AMPHETAMIN_BLOCKED, 0u, 0u, 0u, 3u);
    }

    if (in->backlog > UINT32_MAX - in->ambiguous_tasks) {
        demand = UINT32_MAX;
    } else {
        demand = in->backlog + in->ambiguous_tasks;
    }

    /* Situational activation: no clock or fixed schedule is involved. */
    if (demand == 0u && in->resource_pressure < 70u) {
        return decision(AMPHETAMIN_STANDBY, 0u, 0u, 0u, 0u);
    }

    if (in->max_credits == 0u ||
        (uint64_t)in->available_credits * 100u <=
        (uint64_t)in->max_credits * REFILL_THRESHOLD_PERCENT) {
        return decision((in->resource_pressure >= RESOURCE_HUNT_THRESHOLD || in->overload_score >= RESOURCE_HUNT_THRESHOLD) ? AMPHETAMIN_RESOURCE_HUNT : AMPHETAMIN_REFILL, 0u, 1u, (in->resource_pressure >= RESOURCE_HUNT_THRESHOLD || in->overload_score >= RESOURCE_HUNT_THRESHOLD) ? 1u : 0u, 4u);
    }

    if (in->max_workers == 0u || in->available_credits == 0u) {
        return decision(AMPHETAMIN_REFILL, 0u, 1u, 4u);
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
        return decision(AMPHETAMIN_REFILL, 0u, 1u, 4u);
    }

    /* Uniform bounded choice. Host must supply a CSPRNG value. */
    lower = 1u;
    selected = lower + (in->random_u32 % (upper - lower + 1u));
    if (in->resource_pressure >= RESOURCE_HUNT_THRESHOLD ||
        in->overload_score >= RESOURCE_HUNT_THRESHOLD) {
        return decision(AMPHETAMIN_RESOURCE_HUNT, selected, 0u, 1u, 7u);
    }
    if (in->resource_pressure >= MAXIMUM_DRIVE_THRESHOLD ||
        in->overload_score >= MAXIMUM_DRIVE_THRESHOLD) {
        return decision(AMPHETAMIN_MAXIMUM_DRIVE, selected, 0u, 0u, 6u);
    }
    return decision(AMPHETAMIN_BOOST, selected, 0u, 0u, 5u);
}
