import assert from "node:assert/strict";
import { buildRestaurantMonitorHealth } from "./restaurant-monitor-health.mjs";

const makeSummary = shard => ({
  restaurantsChecked: shard === 0 ? 1 : 0,
  externalEntriesChecked: shard === 1 ? 1 : 0,
  pagesChecked: 2,
  subpagesChecked: 1,
  homepageSnapshots: 1,
  configuredWebsiteSources: 1,
  cardsChecked: 0,
  changes: 0,
  errors: 0,
  officialHomepageSnapshots: 1
});
const rows = Array.from({ length: 40 }, (_, shard) => ({
  shard,
  summary: JSON.stringify(makeSummary(shard)),
  errors: "[]",
  completedAt: "2026-11-18T05:" + String(shard).padStart(2, "0") + ":30.000Z"
}));
const baselineRows = rows.map((row, index) => index === 39 ? {
  ...row,
  summary: JSON.stringify({ ...makeSummary(index), configuredWebsiteSources: 2 }),
  errors: JSON.stringify([{ name: "Testquelle", error: "Nicht erreichbar" }])
} : row);
const baseline = {
  completeAt: "2026-11-17T05:40:00.000Z",
  startedAt: "2026-11-17T05:00:00.000Z",
  finishedAt: "2026-11-17T05:40:00.000Z"
};
const inventory = {
  totalRestaurantEntries: 41,
  sourceRows: 41,
  officialSources: 37,
  officialSnapshots: 36,
  externalSources: 4,
  externalSnapshots: 4,
  baselineProposalCount: 0
};
const healthy = buildRestaurantMonitorHealth({
  baseline, inventory, baselineShardRows: [],
  manualBaselineReport: {
    startedAt: baseline.startedAt, finishedAt: baseline.finishedAt,
    baselineOnly: true, baselineComplete: true, totalSources: 41,
    homepageSnapshots: 40, proposals: 0, errorsCount: 1
  },
  shardRows: rows,
  email: { status: "sent", sentAt: "2026-11-18T05:40:01.000Z" },
  runDate: "2026-11-18"
});
assert.equal(healthy.baseline.complete, true);
assert.equal(healthy.baseline.proposalFree, true);
assert.equal(healthy.baseline.proposalCountDuringPass, 0);
assert.equal(healthy.baseline.coveragePercent, 97.6);
assert.equal(healthy.baseline.coverageVerified, true);
assert.equal(healthy.baseline.source, "manual-run-report");
assert.equal(healthy.baseline.missingSources, 1);
assert.equal(healthy.baseline.currentCoveragePercent, 97.6);
assert.equal(healthy.today.shardsComplete, true);
assert.equal(healthy.today.shardsStored, 40);
assert.deepEqual(healthy.today.shardIds, Array.from({ length: 40 }, (_, index) => index + 1));
assert.equal(healthy.today.summary.totalRestaurantEntries, 41);
assert.equal(healthy.today.summary.restaurantsChecked, 1);
assert.equal(healthy.today.summary.externalEntriesChecked, 1);
assert.equal(healthy.today.summary.shardsCompleted, 40);
assert.equal(healthy.today.email.recordedAsSent, true);

const duplicateRows = rows.slice(0, 39).concat([{ ...rows[0] }]);
const duplicate = buildRestaurantMonitorHealth({
  baseline, inventory, shardRows: duplicateRows, runDate: "2026-11-18"
});
assert.equal(duplicate.today.shardsComplete, false);
assert.deepEqual(duplicate.today.missingShardIds, [40]);
assert.deepEqual(duplicate.today.duplicateShardIds, [1]);

const scheduledBaseline = buildRestaurantMonitorHealth({
  baseline, inventory,
  baselineShardRows: baselineRows,
  shardRows: rows,
  runDate: "2026-11-18"
});
assert.equal(scheduledBaseline.baseline.coverageVerified, true);
assert.equal(scheduledBaseline.baseline.source, "scheduled-shard-records");
assert.equal(scheduledBaseline.baseline.coveragePercent, 97.6);

const unverifiedBaseline = buildRestaurantMonitorHealth({
  baseline, inventory, baselineShardRows: [], shardRows: rows, runDate: "2026-11-18"
});
assert.equal(unverifiedBaseline.baseline.coverageVerified, false);
assert.equal(unverifiedBaseline.baseline.proposalFree, false);

const proposalDuringBaseline = buildRestaurantMonitorHealth({
  baseline, inventory: { ...inventory, baselineProposalCount: 1 },
  manualBaselineReport: {
    startedAt: baseline.startedAt, finishedAt: baseline.finishedAt,
    baselineOnly: true, baselineComplete: true, totalSources: 41,
    homepageSnapshots: 40, proposals: 0, errorsCount: 1
  },
  shardRows: rows, runDate: "2026-11-18"
});
assert.equal(proposalDuringBaseline.baseline.complete, true);
assert.equal(proposalDuringBaseline.baseline.proposalFree, false);

const invalidSummary = buildRestaurantMonitorHealth({
  baseline, inventory, shardRows: rows.map((row, index) =>
    index === 4 ? { ...row, summary: "not-json" } : row
  ), runDate: "2026-11-18"
});
assert.equal(invalidSummary.today.shardsComplete, false);
assert.equal(invalidSummary.today.summariesValid, false);

const noEmail = buildRestaurantMonitorHealth({
  baseline, inventory, shardRows: rows, email: null, runDate: "2026-11-18"
});
assert.equal(noEmail.today.email.recordedAsSent, false);

console.log("Read-only monitoring health summary: all tests passed.");
