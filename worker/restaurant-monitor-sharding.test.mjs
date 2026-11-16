import test from "node:test";
import assert from "node:assert/strict";
import { getMonitorShardIndex, isMonitorFinalizerTime } from "./restaurant-monitor-sharding.mjs";

test("maps all 80 shard slots to the same Berlin local schedule in CET and CEST", () => {
  assert.equal(getMonitorShardIndex("2026-01-15T05:00:00Z"), 0); // CET 06:00
  assert.equal(getMonitorShardIndex("2026-01-15T06:19:00Z"), 79); // CET 07:19
  assert.equal(getMonitorShardIndex("2026-07-15T04:00:00Z"), 0); // CEST 06:00
  assert.equal(getMonitorShardIndex("2026-07-15T05:19:00Z"), 79); // CEST 07:19
});

test("starts finalization at 07:30 Berlin time and keeps recovery open through 08:59", () => {
  assert.equal(isMonitorFinalizerTime("2026-01-15T06:29:00Z"), false); // CET 07:29
  assert.equal(isMonitorFinalizerTime("2026-01-15T06:30:00Z"), true);  // CET 07:30
  assert.equal(isMonitorFinalizerTime("2026-01-15T07:59:00Z"), true);  // CET 08:59
  assert.equal(isMonitorFinalizerTime("2026-01-15T08:00:00Z"), false); // CET 09:00
  assert.equal(isMonitorFinalizerTime("2026-07-15T05:30:00Z"), true);  // CEST 07:30
  assert.equal(isMonitorFinalizerTime("2026-07-15T06:59:00Z"), true);  // CEST 08:59
  assert.equal(isMonitorFinalizerTime("2026-07-15T07:00:00Z"), false); // CEST 09:00
});

test("finalizer recovery slots do not overlap the 80 shard assignments", () => {
  for (const instant of [
    "2026-01-15T06:30:00Z",
    "2026-01-15T07:00:00Z",
    "2026-07-15T05:30:00Z",
    "2026-07-15T06:00:00Z"
  ]) {
    assert.equal(getMonitorShardIndex(instant), -1);
    assert.equal(isMonitorFinalizerTime(instant), true);
  }
});


test("a full initial shard pass completes baseline despite unreachable configured websites", async () => {
  const { isBaselinePassComplete } = await import("./restaurant-monitor-sharding.mjs");
  assert.equal(isBaselinePassComplete({ baselineCompleteAt: "", baselineOnly: true, shardsCompleted: 80, shardCount: 80 }), true);
  assert.equal(isBaselinePassComplete({ baselineCompleteAt: "", baselineOnly: true, shardsCompleted: 79, shardCount: 80 }), false);
  assert.equal(isBaselinePassComplete({ baselineCompleteAt: "", baselineOnly: false, shardsCompleted: 80, shardCount: 80 }), false);
  assert.equal(isBaselinePassComplete({ baselineCompleteAt: "2026-11-16T08:00:00Z", baselineOnly: false, shardsCompleted: 0, shardCount: 80 }), true);
});
