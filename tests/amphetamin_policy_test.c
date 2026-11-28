#include <assert.h>
#include <stdio.h>
#include "../src/amphetamin_policy.h"

static void test_idle_does_not_consume_budget(void) {
    AmphetaminInput in = {0};
    in.quality_score = 95;
    in.available_credits = 100;
    in.max_credits = 100;
    in.max_workers = 16;
    AmphetaminDecision out = amphetamin_evaluate(&in);
    assert(out.mode == AMPHETAMIN_STANDBY);
    assert(out.worker_count == 0);
    assert(out.request_refill == 0);
}

static void test_backlog_activates_boost(void) {
    AmphetaminInput in = {0};
    in.backlog = 40;
    in.ambiguous_tasks = 8;
    in.resource_pressure = 20;
    in.available_credits = 100;
    in.max_credits = 100;
    in.quality_score = 95;
    in.max_workers = 16;
    in.random_u32 = 7;
    AmphetaminDecision out = amphetamin_evaluate(&in);
    assert(out.mode == AMPHETAMIN_BOOST);
    assert(out.worker_count >= 1 && out.worker_count <= 16);
    assert(out.request_refill == 0);
}

static void test_low_credits_requests_refill(void) {
    AmphetaminInput in = {0};
    in.backlog = 12;
    in.available_credits = 5;
    in.max_credits = 100;
    in.quality_score = 90;
    in.max_workers = 12;
    in.random_u32 = 2;
    AmphetaminDecision out = amphetamin_evaluate(&in);
    assert(out.request_refill == 1);
    assert(out.mode == AMPHETAMIN_REFILL);
}

static void test_overload_trips_circuit_breaker(void) {
    AmphetaminInput in = {0};
    in.backlog = 100;
    in.resource_pressure = 100;
    in.overload_score = 95;
    in.available_credits = 100;
    in.max_credits = 100;
    in.quality_score = 100;
    in.max_workers = 32;
    AmphetaminDecision out = amphetamin_evaluate(&in);
    assert(out.mode == AMPHETAMIN_COOLDOWN);
    assert(out.worker_count == 0);
    assert(out.request_refill == 0);
}

static void test_bad_quality_fails_closed(void) {
    AmphetaminInput in = {0};
    in.backlog = 20;
    in.available_credits = 100;
    in.max_credits = 100;
    in.quality_score = 30;
    in.max_workers = 16;
    AmphetaminDecision out = amphetamin_evaluate(&in);
    assert(out.mode == AMPHETAMIN_BLOCKED);
    assert(out.worker_count == 0);
}


static void test_cooldown_is_latched_without_a_timer(void) {
    AmphetaminInput in = {0};
    in.backlog = 8;
    in.cooldown_latched = 1;
    in.recovery_score = 79;
    in.available_credits = 100;
    in.max_credits = 100;
    in.quality_score = 100;
    in.max_workers = 16;
    AmphetaminDecision out = amphetamin_evaluate(&in);
    assert(out.mode == AMPHETAMIN_COOLDOWN);
    assert(out.worker_count == 0);
    assert(out.request_refill == 0);
}

static void test_cooldown_releases_only_on_recovery_signals(void) {
    AmphetaminInput in = {0};
    in.backlog = 8;
    in.cooldown_latched = 1;
    in.recovery_score = 90;
    in.overload_score = 20;
    in.resource_pressure = 30;
    in.available_credits = 100;
    in.max_credits = 100;
    in.quality_score = 100;
    in.max_workers = 16;
    in.random_u32 = 0;
    AmphetaminDecision out = amphetamin_evaluate(&in);
    assert(out.mode == AMPHETAMIN_BOOST);
    assert(out.worker_count == 1);
}

int main(void) {
    test_idle_does_not_consume_budget();
    test_backlog_activates_boost();
    test_low_credits_requests_refill();
    test_overload_trips_circuit_breaker();
    test_bad_quality_fails_closed();
    test_cooldown_is_latched_without_a_timer();
    test_cooldown_releases_only_on_recovery_signals();
    puts("AMPHETAMIN C policy tests: 7 passed");
    return 0;
}
