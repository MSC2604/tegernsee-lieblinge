import assert from "node:assert/strict";
import { sendRestaurantWebsiteDigest } from "./restaurant-monitor-email.mjs";

let proposalRows = [
  [
    { value: "12" }, { value: "Gasthof <See>" }, { value: "telefon" },
    { value: "08022 111111" }, { value: "08022 222222" },
    { value: "https://restaurant.example/kontakt" }, { value: "2026-11-11T05:00:00Z" }
  ],
  [
    { value: "13" }, { value: "Schwarzentenn-Alm" }, { value: "externe_links" },
    { value: "Telefon&nbsp;: tel:+49-8022-123456\nTisch: https://example.de/book?step=date&amp;source=site" },
    { value: "Tisch reservieren: https://example.de/book?source=site&step=date\nTelefon: tel:+498022123456" },
    { value: "https://restaurant.example/" }, { value: "2026-11-11T05:01:00Z" }
  ],
  [
    { value: "14" }, { value: "Bräustüberl Tegernsee" }, { value: "website_text" },
    { value: "Shopify inventory_management qty 92 diff_day_create 23.13" },
    { value: "Shopify inventory_management qty 92 diff_day_create 23.19" },
    { value: "https://braustuberl.example/" }, { value: "2026-11-11T05:02:00Z" }
  ]
];
let cardRows = [[
  { value: "26" }, { value: "Obere Firstalm" }, { value: "speisekarte" },
  { value: "https://restaurant.example/karte.pdf" }, { value: "2026-11-11T05:00:00Z" }
]];
let proposalUpdated = 0, cardUpdated = 0, sentPayloads = [];
const emailRunStates = new Map();
let failNextSentMark = false;
let sendRunIndex = 10;
const db = async (sql, args = [], wantRows = false) => {
  if (sql.startsWith("CREATE TABLE IF NOT EXISTS restaurant_monitor_email_runs")) return { results: [] };
  if (sql.startsWith("INSERT INTO restaurant_monitor_email_runs")) {
    const runDate = args[0]?.value;
    if (emailRunStates.has(runDate)) return { results: [{ response: { result: { rows: [] } } }] };
    emailRunStates.set(runDate, "sending");
    return { results: [{ response: { result: { rows: [[{ value: runDate }]] } } }] };
  }
  if (sql.startsWith("SELECT status FROM restaurant_monitor_email_runs")) {
    const status = emailRunStates.get(args[0]?.value) || "";
    return { results: [{ response: { result: { rows: status ? [[{ value: status }]] : [] } } }] };
  }
  if (sql.startsWith("UPDATE restaurant_monitor_email_runs SET status='sending'")) {
    const runDate = args[1]?.value;
    if (emailRunStates.get(runDate) !== "retryable") return { results: [{ response: { result: { rows: [] } } }] };
    emailRunStates.set(runDate, "sending");
    return { results: [{ response: { result: { rows: [[{ value: runDate }]] } } }] };
  }
  if (sql.startsWith("UPDATE restaurant_monitor_email_runs SET status='sent'")) {
    if (failNextSentMark) {
      failNextSentMark = false;
      throw new Error("simulierter Datenbankfehler nach Brevo-Annahme");
    }
    emailRunStates.set(args[1]?.value, "sent");
    return { results: [] };
  }
  if (sql.startsWith("UPDATE restaurant_monitor_email_runs SET status=?")) {
    emailRunStates.set(args[2]?.value, args[0]?.value);
    return { results: [] };
  }
  if (sql.startsWith("SELECT p.id")) {
    assert.match(sql, /p\.field_name IN/);
    const allowed = new Set(["telefon","email","website","adresse","oeffnungszeiten","ruhetag","betriebsferien","dokumente","externe_links"]);
    return { results: [{ response: { result: { rows: proposalRows.filter(row => allowed.has(row[2]?.value)) } } }] };
  }
  if (sql.startsWith("SELECT c.restaurant_id")) return { results: [{ response: { result: { rows: cardRows } } }] };
  if (sql.startsWith("UPDATE restaurant_change_proposals")) { proposalUpdated++; return { results: [] }; }
  if (sql.startsWith("UPDATE restaurant_card_checks")) { cardUpdated++; return { results: [] }; }
  throw new Error("Unerwartete SQL-Abfrage: " + sql);
};
const missing = await sendRestaurantWebsiteDigest({ db, env: {} });
assert.equal(missing.sent, false);
assert.equal(proposalUpdated, 0);
assert.equal(cardUpdated, 0);

let invalidCountSendCalls = 0;
const invalidCounts = await sendRestaurantWebsiteDigest({
  db,
  env: { BREVO_API_KEY:"test-key", BREVO_FROM_EMAIL:"verified@example.org", MONITOR_NOTIFICATION_EMAIL:"recipient@example.org" },
  summary: { runDate:"2026-11-25" },
  fetchImpl: async () => {
    invalidCountSendCalls++;
    return new Response(JSON.stringify({messageId:"must-not-send"}), {status:201});
  }
});
assert.equal(invalidCounts.sent, false);
assert.equal(invalidCounts.acceptedByProvider, false);
assert.match(invalidCounts.reason, /Restaurant-Gesamtzahl/);
assert.equal(invalidCountSendCalls, 0, "A report with missing counts must never be sent.");
const send = async () => sendRestaurantWebsiteDigest({
  db,
  env: { BREVO_API_KEY:"test-key", BREVO_FROM_EMAIL:"verified@example.org", MONITOR_NOTIFICATION_EMAIL:"recipient@example.org" },
  summary: { totalRestaurantEntries:41, restaurantsWithoutWebsiteSource:3, restaurantsChecked:41, pagesChecked:90, cardsChecked:null, errors:[], runDate:"2026-11-" + String(++sendRunIndex).padStart(2,"0") },
  fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.brevo.com/v3/smtp/email");
    sentPayloads.push(JSON.parse(options.body));
    return new Response(JSON.stringify({messageId:"test-message"}), {status:201,headers:{"Content-Type":"application/json"}});
  },
  now: () => "2026-11-11T06:00:00.000Z"
});
const changed = await send();
assert.equal(changed.sent,true);
assert.equal(changed.count,2, "Technical-only legacy proposals must not be counted in the email");
assert.equal(changed.proposalCount,1);
assert.equal(changed.ignoredTechnicalProposalCount,1);
assert.equal(changed.cardChangeCount,1);
assert.equal(proposalUpdated,1, "Only the meaningful proposal is marked as notified");
assert.equal(cardUpdated,1);
assert.equal(sentPayloads[0].to[0].email,"recipient@example.org");
assert.match(sentPayloads[0].textContent,/Restaurants insgesamt im Datenbestand: 41/);
assert.match(sentPayloads[0].textContent,/Ohne hinterlegte Website \/ externen Eintrag: 3/);
assert.match(sentPayloads[0].htmlContent,/Restaurants insgesamt im Datenbestand: 41/);
assert.match(sentPayloads[0].htmlContent,/Ohne hinterlegte Website \/ externen Eintrag: 3/);
assert.match(sentPayloads[0].htmlContent,/Gasthof &lt;See&gt;/);
assert.match(sentPayloads[0].textContent,/08022 222222/);
assert.doesNotMatch(sentPayloads[0].textContent,/Schwarzentenn-Alm/);
assert.doesNotMatch(sentPayloads[0].htmlContent,/&amp;source=site/);
assert.match(sentPayloads[0].textContent,/Obere Firstalm/); 
assert.match(sentPayloads[0].textContent,/separate Kartenprüfung/);
assert.doesNotMatch(sentPayloads[0].textContent,/Bräustüberl Tegernsee/);
proposalRows=[]; cardRows=[];
const unchanged=await send();
assert.equal(unchanged.sent,true);
assert.equal(unchanged.count,0);
assert.match(sentPayloads[1].subject,/keine Änderungen/);
assert.match(sentPayloads[1].textContent,/Keine Änderungen festgestellt/);
assert.equal(proposalUpdated,1);
assert.equal(cardUpdated,1);

// Ein 5xx-Fehler ist kein sicherer Beleg, dass Brevo die Nachricht nicht angenommen hat.
// Deshalb darf derselbe Bericht nicht automatisch erneut gesendet werden.
let ambiguousServerErrorCalls=0;
await assert.rejects(() => sendRestaurantWebsiteDigest({
  db,
  env: { BREVO_API_KEY:"test-key", BREVO_FROM_EMAIL:"verified@example.org", MONITOR_NOTIFICATION_EMAIL:"recipient@example.org" },
  summary: { totalRestaurantEntries:40, restaurantsWithoutWebsiteSource:0, runDate:"2026-11-26" },
  fetchImpl: async () => {
    ambiguousServerErrorCalls++;
    return new Response("gateway error", {status:500});
  }
}), /HTTP 500/);
assert.equal(ambiguousServerErrorCalls,1, "Ambiguous 5xx responses must not trigger duplicate email retries.");

let timeoutCalls=0;
await assert.rejects(() => sendRestaurantWebsiteDigest({
  db,
  env: { BREVO_API_KEY:"test-key", BREVO_FROM_EMAIL:"verified@example.org", MONITOR_NOTIFICATION_EMAIL:"recipient@example.org" },
  summary: { totalRestaurantEntries:40, restaurantsWithoutWebsiteSource:0, runDate:"2026-11-27" },
  fetchImpl: async () => {
    timeoutCalls++;
    return new Response("request timeout", {status:408});
  }
}), /HTTP 408/);
assert.equal(timeoutCalls,1, "HTTP 408 must not be retried because provider acceptance can be ambiguous.");

let rateLimitCalls=0;
await assert.rejects(() => sendRestaurantWebsiteDigest({
  db,
  env: { BREVO_API_KEY:"test-key", BREVO_FROM_EMAIL:"verified@example.org", MONITOR_NOTIFICATION_EMAIL:"recipient@example.org" },
  summary: { totalRestaurantEntries:40, restaurantsWithoutWebsiteSource:0, runDate:"2026-11-28" },
  fetchImpl: async () => {
    rateLimitCalls++;
    return new Response("rate limited", {status:429});
  }
}), /HTTP 429/);
assert.equal(rateLimitCalls,3, "An explicit HTTP 429 rejection may be retried up to three times.");

let rateLimitRecoveryCalls=0;
const rateLimitRecoveryOptions = {
  db,
  env: { BREVO_API_KEY:"test-key", BREVO_FROM_EMAIL:"verified@example.org", MONITOR_NOTIFICATION_EMAIL:"recipient@example.org" },
  summary: { totalRestaurantEntries:40, restaurantsWithoutWebsiteSource:0, runDate:"2026-12-01" },
  fetchImpl: async () => {
    rateLimitRecoveryCalls++;
    if (rateLimitRecoveryCalls <= 3) return new Response("rate limited", {status:429});
    return new Response(JSON.stringify({messageId:"recovered-message"}), {status:201,headers:{"Content-Type":"application/json"}});
  }
};
await assert.rejects(() => sendRestaurantWebsiteDigest(rateLimitRecoveryOptions), /HTTP 429/);
const recoveredRateLimitSend = await sendRestaurantWebsiteDigest(rateLimitRecoveryOptions);
assert.equal(recoveredRateLimitSend.sent,true);
assert.equal(rateLimitRecoveryCalls,4,"A confirmed 429 rejection may be retried on the next finalizer run.");

// Derselbe Kalendertag darf auch bei einem erneuten Abschlusslauf nur eine Mail auslösen.
let duplicateDayCalls=0;
const duplicateDayOptions = {
  db,
  env: { BREVO_API_KEY:"test-key", BREVO_FROM_EMAIL:"verified@example.org", MONITOR_NOTIFICATION_EMAIL:"recipient@example.org" },
  summary: { totalRestaurantEntries:40, restaurantsWithoutWebsiteSource:0, runDate:"2026-11-29" },
  fetchImpl: async () => {
    duplicateDayCalls++;
    return new Response(JSON.stringify({messageId:"test-message"}), {status:201,headers:{"Content-Type":"application/json"}});
  }
};
const firstDailySend=await sendRestaurantWebsiteDigest(duplicateDayOptions);
const secondDailySend=await sendRestaurantWebsiteDigest(duplicateDayOptions);
assert.equal(firstDailySend.sent,true);
assert.equal(secondDailySend.sent,true);
assert.equal(secondDailySend.duplicateSuppressed,true);
assert.equal(duplicateDayCalls,1,"A duplicate finalizer must not send a second daily report.");

// Ein manueller Prüflauf darf den automatischen Tagesbericht desselben Tages
// nicht durch denselben Idempotenz-Schlüssel blockieren.
let isolatedManualAndScheduledCalls=0;
const isolatedManualAndScheduledOptions = {
  db,
  env: { BREVO_API_KEY:"test-key", BREVO_FROM_EMAIL:"verified@example.org", MONITOR_NOTIFICATION_EMAIL:"recipient@example.org" },
  fetchImpl: async () => {
    isolatedManualAndScheduledCalls++;
    return new Response(JSON.stringify({messageId:"isolated-message"}), {status:201,headers:{"Content-Type":"application/json"}});
  }
};
const scheduledSameDay=await sendRestaurantWebsiteDigest({
  ...isolatedManualAndScheduledOptions,
  summary:{runDate:"2026-12-02"}
});
const manualSameDay=await sendRestaurantWebsiteDigest({
  ...isolatedManualAndScheduledOptions,
  summary:{runDate:"manual-550e8400-e29b-41d4-a716-446655440000"}
});
assert.equal(scheduledSameDay.sent,true);
assert.equal(manualSameDay.sent,true);
assert.equal(isolatedManualAndScheduledCalls,2,"Manual and scheduled reports on the same day must use separate send locks.");

// Auch wenn Brevo die Mail annimmt, aber das Speichern des Versandstatus fehlschlägt,
// bleibt der Tages-Lock bestehen und verhindert einen zweiten Versand.
let postAcceptanceCalls=0;
const postAcceptanceOptions = {
  db,
  env: { BREVO_API_KEY:"test-key", BREVO_FROM_EMAIL:"verified@example.org", MONITOR_NOTIFICATION_EMAIL:"recipient@example.org" },
  summary: { totalRestaurantEntries:40, restaurantsWithoutWebsiteSource:0, runDate:"2026-11-30" },
  fetchImpl: async () => {
    postAcceptanceCalls++;
    return new Response(JSON.stringify({messageId:"test-message"}), {status:201,headers:{"Content-Type":"application/json"}});
  }
};
failNextSentMark=true;
await assert.rejects(() => sendRestaurantWebsiteDigest(postAcceptanceOptions), /Datenbankfehler nach Brevo-Annahme/);
const postAcceptanceRetry=await sendRestaurantWebsiteDigest(postAcceptanceOptions);
assert.equal(postAcceptanceRetry.sent,false);
assert.equal(postAcceptanceRetry.duplicateSuppressed,true);
assert.equal(postAcceptanceCalls,1,"A DB error after provider acceptance must not cause a second email.");
console.log("Täglicher Restaurant-Prüfbericht: Tages-Doppelversandsperre und Fehler nach Brevo-Annahme getestet.");
