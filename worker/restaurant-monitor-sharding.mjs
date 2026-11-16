// Deterministic assignment independent of the number of restaurants or source URLs.
// Every input item belongs to exactly one configured monitoring shard.
export function selectMonitorShard(items, shardIndex, shardCount) {
  if (!Array.isArray(items) || !Number.isInteger(shardCount) || shardCount < 1 ||
      !Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error("Ungültige Parameter für die Restaurant-Prüfabschnitte.");
  }
  return items.filter((_, index) => index % shardCount === shardIndex);
}


// Convert a scheduled instant into its Europe/Berlin shard slot.
// The same 80 local minutes are used in CET and CEST despite UTC offset changes.
export function getMonitorShardIndex(scheduledInstant) {
  const date = scheduledInstant instanceof Date ? scheduledInstant : new Date(scheduledInstant);
  if (!Number.isFinite(date.getTime())) return -1;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map(part => [part.type, part.value]));
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const index = hour === 6 ? minute : hour === 7 ? 60 + minute : -1;
  return Number.isInteger(index) && index >= 0 && index < 80 ? index : -1;
}


// A separate daily finalizer runs after the 80 shard slots.
// Keep retry minutes available so an incomplete run can be diagnosed safely.
export function isMonitorFinalizerTime(scheduledInstant) {
  const date = scheduledInstant instanceof Date ? scheduledInstant : new Date(scheduledInstant);
  if (!Number.isFinite(date.getTime())) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map(part => [part.type, part.value]));
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return hour === 7 && minute >= 30 && minute <= 59;
}
