import test from "node:test";
import assert from "node:assert/strict";
import { runActivationTickSweep } from "../src/amphetamin-controller.mjs";

function fakeDb(rows) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      assert.match(sql, /FROM amphetamin_activation_state/);
      return {
        bind(...values) {
          calls.push(values);
          return {
            all: async () => {
              const [afterTenant, repeatedTenant, afterProject, limit] = values;
              assert.equal(repeatedTenant, afterTenant);
              const active = rows.filter(row =>
                row.activation_remaining_minutes > 0 ||
                row.deployment_streak > 0 ||
                row.burnout_score > 0 ||
                row.recovery_remainder_minutes > 0
              );
              const remaining = active.filter(row =>
                row.tenant_id > afterTenant ||
                (row.tenant_id === afterTenant && row.project_id > afterProject)
              );
              return { results: remaining.slice(0, limit) };
            }
          };
        }
      };
    }
  };
}

test("tick sweep paginates all active tenant/project rows and uses one stable event identity", async () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({
    tenant_id: "tenant-a",
    project_id: `project-${String(index).padStart(3, "0")}`,
    activation_remaining_minutes: index % 2 === 0 ? 20 : 0,
    deployment_streak: index % 2 === 0 ? 1 : 0,
    burnout_score: 10,
    recovery_remainder_minutes: 0
  }));
  const db = fakeDb(rows);
  const applied = [];
  const scheduledTime = Date.parse("2026-11-28T14:00:00.000Z");

  const result = await runActivationTickSweep(db, scheduledTime, async (...args) => {
    applied.push(args.slice(1));
    return { replayed: false };
  });

  assert.equal(result.processed, 205);
  assert.equal(result.replayed, 0);
  assert.equal(db.calls.length, 3);
  assert.equal(applied.length, 205);
  assert.ok(applied.every(([, eventId, eventType, occurredAt]) =>
    eventId === `tick:${Math.floor(scheduledTime / 60000)}` &&
    eventType === "tick" &&
    occurredAt === "2026-11-28T14:00:00.000Z"
  ));
});

test("replaying the same scheduled minute reuses the event ID and reports replays", async () => {
  const rows = [{
    tenant_id: "tenant-a",
    project_id: "project-a",
    activation_remaining_minutes: 10,
    deployment_streak: 1,
    burnout_score: 5,
    recovery_remainder_minutes: 0
  }];
  const db = fakeDb(rows);
  const scheduledTime = Date.parse("2026-11-28T14:01:00.000Z");
  const ids = [];
  const apply = async (_db, _tenant, _project, eventId, type, occurredAt) => {
    ids.push({ eventId, type, occurredAt });
    return { replayed: true };
  };

  const first = await runActivationTickSweep(db, scheduledTime, apply);
  const second = await runActivationTickSweep(db, scheduledTime, apply);

  assert.equal(first.event_id, second.event_id);
  assert.equal(first.replayed, 1);
  assert.equal(second.replayed, 1);
  assert.equal(ids.length, 2);
});

test("tick sweep skips projects with no activation, streak, burnout, or recovery remainder", async () => {
  const db = fakeDb([{
    tenant_id: "tenant-a",
    project_id: "project-idle",
    activation_remaining_minutes: 0,
    deployment_streak: 0,
    burnout_score: 0,
    recovery_remainder_minutes: 0
  }]);
  let calls = 0;
  const result = await runActivationTickSweep(db, Date.parse("2026-11-28T14:02:00.000Z"), async () => {
    calls += 1;
    return { replayed: false };
  });
  assert.equal(result.processed, 0);
  assert.equal(calls, 0);
});

test("tick sweep rejects invalid scheduled timestamps before touching D1", async () => {
  const db = fakeDb([]);
  await assert.rejects(
    runActivationTickSweep(db, Number.NaN, async () => ({ replayed: false })),
    /scheduledTime/
  );
  assert.equal(db.calls.length, 0);
});
