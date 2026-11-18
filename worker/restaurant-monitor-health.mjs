const EXPECTED_SHARD_COUNT = 40;
const SUMMARY_FIELDS = [
  "restaurantsChecked", "externalEntriesChecked", "pagesChecked", "subpagesChecked",
  "homepageSnapshots", "configuredWebsiteSources", "cardsChecked", "changes",
  "errors", "officialHomepageSnapshots"
];

function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function errorCount(value) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function inspectRows(rows, expectedCount) {
  const list = Array.isArray(rows) ? rows : [];
  const ids = list.map(row => Number(row?.shard));
  const unique = new Set(ids);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  const expected = Array.from({ length: expectedCount }, (_, index) => index);
  const missing = expected.filter(id => !unique.has(id));
  const unexpected = [...unique].filter(id => !Number.isInteger(id) || id < 0 || id >= expectedCount);
  const parsed = list.map(row => ({
    row,
    summary: parseObject(row?.summary),
    completedAt: String(row?.completedAt || "")
  }));
  const valid = parsed.every(item => item.summary && item.completedAt &&
    SUMMARY_FIELDS.every(field => Number.isFinite(Number(item.summary[field])) && Number(item.summary[field]) >= 0));
  const sums = Object.fromEntries(SUMMARY_FIELDS.map(field => [
    field, parsed.reduce((total, item) => total + count(item.summary?.[field]), 0)
  ]));
  return {
    rows: list.length,
    distinct: unique.size,
    ids: [...unique].filter(Number.isInteger).sort((a, b) => a - b),
    duplicates: [...new Set(duplicates)].sort((a, b) => a - b),
    missing,
    unexpected,
    valid,
    complete: list.length === expectedCount && unique.size === expectedCount &&
      missing.length === 0 && unexpected.length === 0 && duplicates.length === 0 && valid,
    errorsCount: list.reduce((total, row) => total + errorCount(row?.errors), 0),
    sums
  };
}

export function buildRestaurantMonitorHealth({
  baseline = {},
  inventory = {},
  baselineShardRows = [],
  shardRows = [],
  email = null,
  runDate = ""
} = {}) {
  const completeAt = String(baseline.completeAt || "").trim();
  const startedAt = String(baseline.startedAt || "").trim();
  const finishedAt = String(baseline.finishedAt || "").trim();
  const baselineComplete = !!(completeAt && startedAt && finishedAt);
  const proposalCountDuringPass = count(inventory.baselineProposalCount);
  const officialSources = count(inventory.officialSources);
  const officialSnapshots = Math.min(officialSources, count(inventory.officialSnapshots));
  const externalSources = count(inventory.externalSources);
  const externalSnapshots = Math.min(externalSources, count(inventory.externalSnapshots));
  const totalConfiguredSources = officialSources + externalSources;
  const totalSnapshots = officialSnapshots + externalSnapshots;
  const coveragePercent = totalConfiguredSources
    ? Number((totalSnapshots / totalConfiguredSources * 100).toFixed(1))
    : 100;
  const baselineShards = Array.isArray(baselineShardRows) ? baselineShardRows : [];
  const baselineShardIds = [...new Set(baselineShards.map(row => Number(row?.shard)).filter(Number.isInteger))];
  const baselineErrorsCount = baselineShards.reduce((total, row) => total + errorCount(row?.errors), 0);
  const today = inspectRows(shardRows, EXPECTED_SHARD_COUNT);
  const totalRestaurantEntries = count(inventory.totalRestaurantEntries);
  const sourceRows = count(inventory.sourceRows);
  const todayConfiguredSources = today.sums.configuredWebsiteSources;
  const todaySnapshots = today.sums.homepageSnapshots;
  const todayCoveragePercent = todayConfiguredSources
    ? Number((todaySnapshots / todayConfiguredSources * 100).toFixed(1))
    : 100;
  const emailStatus = String(email?.status || "missing");
  const emailSentAt = String(email?.sentAt || "");

  return {
    baseline: {
      complete: baselineComplete,
      proposalFree: baselineComplete && proposalCountDuringPass === 0,
      completeAt,
      startedAt,
      finishedAt,
      proposalCountDuringPass,
      officialSources,
      officialSnapshots,
      officialMissing: Math.max(0, officialSources - officialSnapshots),
      externalSources,
      externalSnapshots,
      externalMissing: Math.max(0, externalSources - externalSnapshots),
      totalConfiguredSources,
      totalSnapshots,
      coveragePercent,
      officialCoveragePercent: officialSources ? Number((officialSnapshots / officialSources * 100).toFixed(1)) : 100,
      externalCoveragePercent: externalSources ? Number((externalSnapshots / externalSources * 100).toFixed(1)) : 100,
      shardRows: baselineShards.length,
      distinctShards: baselineShardIds.length,
      errorsCount: baselineErrorsCount
    },
    today: {
      runDate: String(runDate || ""),
      shardsStored: today.rows,
      distinctShards: today.distinct,
      shardIds: today.ids.map(id => id + 1),
      missingShardIds: today.missing.map(id => id + 1),
      duplicateShardIds: today.duplicates.map(id => id + 1),
      unexpectedShardIds: today.unexpected.map(id => id + 1),
      shardsComplete: today.complete,
      summariesValid: today.valid,
      email: {
        status: emailStatus,
        sentAt: emailSentAt,
        recordedAsSent: emailStatus === "sent" && !!emailSentAt
      },
      summary: {
        totalRestaurantEntries,
        restaurantsWithoutWebsiteSource: Math.max(0, totalRestaurantEntries - sourceRows),
        officialWebsiteCount: officialSources,
        externalEntryCount: externalSources,
        restaurantsChecked: today.sums.restaurantsChecked,
        externalEntriesChecked: today.sums.externalEntriesChecked,
        pagesChecked: today.sums.pagesChecked,
        subpagesChecked: today.sums.subpagesChecked,
        homepageSnapshots: todaySnapshots,
        configuredWebsiteSources: todayConfiguredSources,
        baselineCoveragePercent: todayCoveragePercent,
        cardsChecked: today.sums.cardsChecked,
        changes: today.sums.changes,
        errors: today.sums.errors,
        officialHomepageSnapshots: today.sums.officialHomepageSnapshots,
        baselineComplete,
        runDate: String(runDate || ""),
        shardsCompleted: today.distinct
      }
    }
  };
}
