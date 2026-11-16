// Deterministic assignment independent of the number of restaurants or source URLs.
// Every input item belongs to exactly one configured monitoring shard.
export function selectMonitorShard(items, shardIndex, shardCount) {
  if (!Array.isArray(items) || !Number.isInteger(shardCount) || shardCount < 1 ||
      !Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error("Ungültige Parameter für die Restaurant-Prüfabschnitte.");
  }
  return items.filter((_, index) => index % shardCount === shardIndex);
}
