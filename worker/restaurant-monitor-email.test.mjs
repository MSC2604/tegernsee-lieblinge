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
  if (sql.startsWith("UPDATE restaurant_monitor_email_runs SET status='sent'")) {
    if (failNextSentMark) {
      failNextSentMark = false;
      throw new Error("simulierter Datenbankfehler nach Brevo-Annahme");
    }
    emailRunStates.set(args[1]?.value, "sent");
    return { results: [] };
  }
  if (sql.startsWith("UPDATE restaurant_monitor_email_runs SET status='unknown'")) {
    emailRunStates.set(args[1]?.value, "unknown");
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
const send = async () => sendRestaurantWebsiteDigest({
  db,
  env: { BREVO_API_KEY:"test-key", BREVO_FROM_EMAIL:"verified@example.org", MONITOR_NOTIFICATION_EMAIL:"recipient@example.org" },
  summary: { restaurantsChecked:41, pagesChecked:90, cardsChecked:null, errors:[], runDate:"2026-11-" + String(++sendRunIndex).padStart(2,"0") },
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
  summary: { runDate:"2026-11-26" },
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
  summary: { runDate:"2026-11-27" },
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
  summary: { runDate:"2026-11-28" },
  fetchImpl: async () => {
    rateLimitCalls++;
    return new Response("rate limited", {status:429});
  }
}), /HTTP 429/);
assert.equal(rateLimitCalls,3, "An explicit HTTP 429 rejection may be retried up to three times.");

// Derselbe Kalendertag darf auch bei einem erneuten Abschlusslauf nur eine Mail auslösen.
let duplicateDayCalls=0;
const duplicateDayOptions = {
  db,
  env: { BREVO_API_KEY:"test-key", BREVO_FROM_EMAIL:"verified@example.org", MONITOR_NOTIFICATION_EMAIL:"recipient@example.org" },
  summary: { runDate:"2026-11-29" },
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

// Auch wenn Brevo die Mail annimmt, aber das Speichern des Versandstatus fehlschlägt,
// bleibt der Tages-Lock bestehen und verhindert einen zweiten Versand.
let postAcceptanceCalls=0;
const postAcceptanceOptions = {
  db,
  env: { BREVO_API_KEY:"test-key", BREVO_FROM_EMAIL:"verified@example.org", MONITOR_NOTIFICATION_EMAIL:"recipient@example.org" },
  summary: { runDate:"2026-11-30" },
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
