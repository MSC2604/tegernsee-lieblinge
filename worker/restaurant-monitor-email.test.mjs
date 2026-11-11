import assert from "node:assert/strict";
import { sendRestaurantWebsiteDigest } from "./restaurant-monitor-email.mjs";

const rows = [[
  { value: "12" }, { value: "Gasthof <See>" }, { value: "telefon" },
  { value: "08022 111111" }, { value: "08022 222222" },
  { value: "https://restaurant.example/kontakt" }, { value: "2026-11-11T05:00:00Z" }
]];
let updated = 0;
let sentPayload = null;
const db = async (sql, args = [], wantRows = false) => {
  if (sql.startsWith("SELECT p.id")) return { results: [{ response: { result: { rows } } }] };
  if (sql.startsWith("UPDATE restaurant_change_proposals")) { updated++; return { results: [] }; }
  throw new Error("Unerwartete SQL-Abfrage: " + sql);
};
const missing = await sendRestaurantWebsiteDigest({ db, env: {} });
assert.equal(missing.sent, false);
assert.equal(updated, 0);

const result = await sendRestaurantWebsiteDigest({
  db,
  env: {
    BREVO_API_KEY: "test-key",
    BREVO_FROM_EMAIL: "verified@example.org",
    MONITOR_NOTIFICATION_EMAIL: "recipient@example.org"
  },
  fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.brevo.com/v3/smtp/email");
    sentPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({ messageId: "test-message" }), {
      status: 201, headers: { "Content-Type": "application/json" }
    });
  },
  now: () => "2026-11-11T06:00:00.000Z"
});
assert.equal(result.sent, true);
assert.equal(result.count, 1);
assert.equal(updated, 1);
assert.equal(sentPayload.to[0].email, "recipient@example.org");
assert.match(sentPayload.htmlContent, /Gasthof &lt;See&gt;/);
assert.match(sentPayload.textContent, /08022 222222/);
console.log("Restaurant-Monitor-E-Mail: Konfiguration, Digest und Markierung getestet.");
