import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
import {
  getExpectedMonitorCron,
  getMonitorShardIndex,
  isBaselinePassComplete
} from "./restaurant-monitor-sharding.mjs";

test("maps exactly 40 local 06:00–06:39 slots to the CET and CEST UTC triggers", () => {
  for (const [date, utcStart, expectedCron] of [
    ["2026-11-18", "05:00:00Z", "0-39 5 * * *"], // CET
    ["2027-07-18", "04:00:00Z", "0-39 4 * * *"]  // CEST
  ]) {
    const slots = Array.from({ length: 40 }, (_, minute) => {
      const instant = new Date(date + "T" + utcStart);
      instant.setUTCMinutes(instant.getUTCMinutes() + minute);
      assert.equal(getExpectedMonitorCron(instant), expectedCron);
      return getMonitorShardIndex(instant);
    });
    assert.deepEqual(slots, Array.from({ length: 40 }, (_, index) => index));
    assert.equal(new Set(slots).size, 40);
    const before = new Date(date + "T" + utcStart);
    before.setUTCMinutes(before.getUTCMinutes() - 1);
    const after = new Date(date + "T" + utcStart);
    after.setUTCMinutes(after.getUTCMinutes() + 40);
    assert.equal(getMonitorShardIndex(before), -1);
    assert.equal(getMonitorShardIndex(after), -1);
    assert.equal(getExpectedMonitorCron(before), "");
    assert.equal(getExpectedMonitorCron(after), "");
  }
});

test("skips the UTC trigger that does not map to local 06:00–06:39", () => {
  assert.equal(getMonitorShardIndex("2026-11-18T04:00:00Z"), -1); // 05:00 CET
  assert.equal(getExpectedMonitorCron("2026-11-18T04:00:00Z"), "");
  assert.equal(getMonitorShardIndex("2027-07-18T05:00:00Z"), -1); // 07:00 CEST
  assert.equal(getExpectedMonitorCron("2027-07-18T05:00:00Z"), "");
  assert.equal(getMonitorShardIndex("2026-11-18T05:40:00Z"), -1);
  assert.equal(getMonitorShardIndex("2027-07-18T04:40:00Z"), -1);
  assert.equal(getMonitorShardIndex(new Date("invalid")), -1);
});

test("baseline completes only after all 40 sections in a baseline-only pass", () => {
  assert.equal(isBaselinePassComplete({ baselineCompleteAt: "", baselineOnly: true, shardsCompleted: 40, shardCount: 40 }), true);
  assert.equal(isBaselinePassComplete({ baselineCompleteAt: "", baselineOnly: true, shardsCompleted: 39, shardCount: 40 }), false);
  assert.equal(isBaselinePassComplete({ baselineCompleteAt: "", baselineOnly: false, shardsCompleted: 40, shardCount: 40 }), false);
  assert.equal(isBaselinePassComplete({ baselineCompleteAt: "2026-11-18T06:40:00Z", baselineOnly: false, shardsCompleted: 0, shardCount: 40 }), true);
});

test("GET /health verifies required settings and a read-only Turso SELECT 1", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async (url, options) => {
    requestCount++;
    assert.match(String(url), /\/v3\/pipeline$/);
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.equal(body.requests[0].stmt.sql, "SELECT 1 AS ok");
    return new Response(JSON.stringify({
      results: [{ response: { result: { rows: [[{ value: 1 }]] } } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await worker.fetch(new Request("https://worker.example/health"), {
      TURSO_DATABASE_URL: "libsql://test-db.example",
      TURSO_AUTH_TOKEN: "test-token",
      ADMIN_PASSWORD: "test-admin",
      BREVO_API_KEY: "test-brevo",
      BREVO_FROM_EMAIL: "verified@example.org"
    }, {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: "tegernsee-restaurants-api", database: "ok" });
    assert.equal(requestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /health fails closed when a required production setting is absent", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => { requestCount++; throw new Error("must not call database"); };
  try {
    const response = await worker.fetch(new Request("https://worker.example/health"), {
      TURSO_DATABASE_URL: "libsql://test-db.example",
      TURSO_AUTH_TOKEN: "test-token",
      ADMIN_PASSWORD: "test-admin",
      BREVO_FROM_EMAIL: "verified@example.org"
    }, {});
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, service: "tegernsee-restaurants-api", database: "not_configured" });
    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
