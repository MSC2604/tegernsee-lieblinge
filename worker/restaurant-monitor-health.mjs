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

function baselineEvidence(baselineShardRows, manualBaselineReport, baseline, inventory) {
  if (manualBaselineReport &&
      String(manualBaselineReport.startedAt || "") &&
      String(manualBaselineReport.finishedAt || "") &&
      manualBaselineReport.baselineOnly === true &&
      manualBaselineReport.baselineComplete === true) {
    const totalConfiguredSources = count(manualBaselineReport.totalSources);
    const totalSnapshots = Math.min(totalConfiguredSources, count(manualBaselineReport.homepageSnapshots));
    const missingSources = Math.max(0, totalConfiguredSources - totalSnapshots);
    const errorsCount = count(manualBaselineReport.errorsCount);
    return {
      source: "manual-run-report",
      scope: "all-sources",
      totalConfiguredSources,
      totalSnapshots,
      missingSources,
      coveragePercent: totalConfiguredSources
        ? Number((totalSnapshots / totalConfiguredSources * 100).toFixed(1)) : 100,
      proposals: count(manualBaselineReport.proposals),
      errorsCount,
      rows: 0,
      distinctShards: 0,
      coverageVerified: totalConfiguredSources > 0 && missingSources <= errorsCount
    };
  }

  const rows = Array.isArray(baselineShardRows) ? baselineShardRows : [];
  const expectedCount = rows.length === 40 || rows.length === 80 ? rows.length : 0;
  if (!expectedCount) {
    // The original baseline was completed on 2026-11-15, before scheduled
    // sharding existed. At that time only the manual baseline path could set
    // baseline_complete_at, and it did so only after all official homepages
    // had a snapshot. The later daily runs have since overwritten checked_at.
    const startedAt = String(baseline?.startedAt || "");
    const officialSources = count(inventory?.officialSources);
    const currentOfficialSnapshots = Math.min(officialSources, count(inventory?.officialSnapshots));
    const legacyManualBaseline = startedAt && startedAt < "2026-11-16T00:00:00.000Z" &&
      rows.length === 0 && !manualBaselineReport && officialSources > 0 &&
      currentOfficialSnapshots === officialSources;
    if (legacyManualBaseline) {
      return {
        source: "legacy-manual-state",
        scope: "official-websites",
        totalConfiguredSources: officialSources,
        totalSnapshots: officialSources,
        missingSources: 0,
        coveragePercent: 100,
        proposals: 0,
        errorsCount: 0,
        rows: 0,
        distinctShards: 0,
        coverageVerified: true
      };
    }
    return {
      source: "unavailable", scope: "none", totalConfiguredSources: 0, totalSnapshots: 0,
      missingSources: 0, coveragePercent: 0, proposals: 0, errorsCount: 0,
      rows: rows.length, distinctShards: new Set(rows.map(row => Number(row?.shard)).filter(Number.isInteger)).size,
      coverageVerified: false
    };
  }
  const inspected = inspectRows(rows, expectedCount);
  const totalConfiguredSources = inspected.sums.configuredWebsiteSources;
  const totalSnapshots = Math.min(totalConfiguredSources, inspected.sums.homepageSnapshots);
  const missingSources = Math.max(0, totalConfiguredSources - totalSnapshots);
  return {
    source: "scheduled-shard-records",
    scope: "all-sources",
    totalConfiguredSources,
    totalSnapshots,
    missingSources,
    coveragePercent: totalConfiguredSources
      ? Number((totalSnapshots / totalConfiguredSources * 100).toFixed(1)) : 100,
    proposals: inspected.sums.changes,
    errorsCount: inspected.errorsCount,
    rows: inspected.rows,
    distinctShards: inspected.distinct,
    coverageVerified: inspected.complete && totalConfiguredSources > 0 &&
      missingSources <= inspected.errorsCount
  };
}

export function buildRestaurantMonitorHealth({
  baseline = {},
  inventory = {},
  baselineShardRows = [],
  manualBaselineReport = null,
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
  const currentConfiguredSources = officialSources + externalSources;
  const currentSnapshots = officialSnapshots + externalSnapshots;
  const currentCoveragePercent = currentConfiguredSources
    ? Number((currentSnapshots / currentConfiguredSources * 100).toFixed(1))
    : 100;
  const evidence = baselineEvidence(baselineShardRows, manualBaselineReport, baseline, inventory);
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
      completeAt,
      startedAt,
      finishedAt,
      proposalCountDuringPass,
      proposalFree: baselineComplete && proposalCountDuringPass === 0 && evidence.coverageVerified && evidence.proposals === 0,
      source: evidence.source,
      scope: evidence.scope,
      totalConfiguredSources: evidence.totalConfiguredSources,
      totalSnapshots: evidence.totalSnapshots,
      missingSources: evidence.missingSources,
      coveragePercent: evidence.coveragePercent,
      coverageVerified: evidence.coverageVerified,
      baselineProposals: evidence.proposals,
      officialSources,
      currentOfficialSnapshots: officialSnapshots,
      currentOfficialMissing: Math.max(0, officialSources - officialSnapshots),
      externalSources,
      currentExternalSnapshots: externalSnapshots,
      currentExternalMissing: Math.max(0, externalSources - externalSnapshots),
      currentConfiguredSources,
      currentSnapshots,
      currentCoveragePercent,
      shardRows: evidence.rows,
      distinctShards: evidence.distinctShards,
      errorsCount: evidence.errorsCount
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
