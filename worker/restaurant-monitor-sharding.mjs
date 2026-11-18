// Deterministic assignment independent of the number of restaurants or source URLs.
export function selectMonitorShard(items, shardIndex, shardCount) {
  if (!Array.isArray(items) || !Number.isInteger(shardCount) || shardCount < 1 ||
      !Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error("Ungültige Parameter für die Restaurant-Prüfabschnitte.");
  }
  return items.filter((_, index) => index % shardCount === shardIndex);
}

// Return the only UTC cron expression whose scheduled instant maps to the
// active 06:00–06:39 Europe/Berlin window. The other configured UTC trigger
// is deliberately skipped on each date.
export function getExpectedMonitorCron(scheduledInstant) {
  const date = scheduledInstant instanceof Date ? scheduledInstant : new Date(scheduledInstant);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map(part => [part.type, part.value]));
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (hour !== 6 || !Number.isInteger(minute) || minute < 0 || minute > 39) return "";
  const utcHour = date.getUTCHours();
  if (utcHour === 4) return "0-39 4 * * *"; // CEST
  if (utcHour === 5) return "0-39 5 * * *"; // CET
  return "";
}

// The minute within the local 06:00–06:39 window is the stable shard ID.
export function getMonitorShardIndex(scheduledInstant) {
  const date = scheduledInstant instanceof Date ? scheduledInstant : new Date(scheduledInstant);
  if (!getExpectedMonitorCron(date)) return -1;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map(part => [part.type, part.value]));
  return Number(parts.minute);
}

// All 40 scheduled sections must finish for the initial baseline to complete.
// Unreachable sources remain explicit errors and get their baseline on the first
// later successful fetch; they are never interpreted as data changes.
export function isBaselinePassComplete({ baselineCompleteAt, baselineOnly, shardsCompleted, shardCount }) {
  if (String(baselineCompleteAt || "").trim()) return true;
  return baselineOnly === true && Number.isInteger(shardCount) && shardCount > 0 &&
    Number.isInteger(shardsCompleted) && shardsCompleted === shardCount;
}
