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
const db = async (sql, args = [], wantRows = false) => {
  if (sql.startsWith("SELECT p.id")) {\n    assert.match(sql, /p\\.field_name IN/);\n    const allowed = new Set(["telefon","email","website","adresse","oeffnungszeiten","ruhetag","betriebsferien","dokumente","externe_links"]);\n    return { results: [{ response: { result: { rows: proposalRows.filter(row => allowed.has(row[2]?.value)) } } }] };\n  }
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
  summary: { restaurantsChecked:41, pagesChecked:90, cardsChecked:null, errors:[] },
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
assert.match(sentPayloads[0].textContent,/Obere Firstalm/);\nassert.match(sentPayloads[0].textContent,/separate Kartenprüfung/);\nassert.doesNotMatch(sentPayloads[0].textContent,/Bräustüberl Tegernsee/);
proposalRows=[]; cardRows=[];
const unchanged=await send();
assert.equal(unchanged.sent,true);
assert.equal(unchanged.count,0);
assert.match(sentPayloads[1].subject,/keine Änderungen/);
assert.match(sentPayloads[1].textContent,/Keine Änderungen festgestellt/);
assert.equal(proposalUpdated,1);
assert.equal(cardUpdated,1);
console.log("Täglicher Restaurant-Prüfbericht: Änderungen, Kartenänderungen und Nulländerungsbericht getestet.");
