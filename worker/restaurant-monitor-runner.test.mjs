import assert from "node:assert/strict";
import { runRestaurantWebsiteMonitor } from "./restaurant-monitor-runner.mjs";
import { findRestaurantChanges } from "./restaurant-monitor.mjs";

function makeDb() {
  const snapshots = new Map();
  const proposals = new Map();
  const key = (id, url) => id + "|" + url;
  const result = rows => ({ results: [{ response: { result: { rows } } }] });
  const cell = value => ({ value: String(value ?? "") });
  const db = async (sql, args = [], wantRows = false) => {
    const values = args.map(item => item?.value ?? "");
    if (sql.startsWith("SELECT content_hash")) {
      const item = snapshots.get(key(values[0], values[1]));
      return result(item ? [[cell(item.hash), cell(item.data), cell(item.text)]] : []);
    }
    if (sql.startsWith("INSERT OR IGNORE INTO restaurant_change_proposals")) {
      const stored = sql.includes("VALUES (?, 'website_text'")
        ? [values[0], "website_text", ...values.slice(1)]
        : values;
      const proposalKey = stored.join("|");
      if (!proposals.has(proposalKey)) proposals.set(proposalKey, stored);
      return result([]);
    }
    if (sql.includes("INSERT INTO restaurant_site_snapshots")) {
      snapshots.set(key(values[0], values[1]), {
        hash: values[3], data: values[4], text: values[5]
      });
      return result([]);
    }
    throw new Error("Unerwartete SQL-Abfrage: " + sql);
  };
  return { db, snapshots, proposals };
}

const dbState = makeDb();
let contactHtml = '<html><body><h1>Kontakt</h1><p>Telefon: 08022 111111</p><p>E-Mail: info@example.de</p></body></html>';
let homeHtml = '<html><body><h1>Gasthof am See</h1><a href="/kontakt">Kontakt</a><a href="/speisekarte.pdf">Speisekarte</a><a href="https://fremd.example/">Extern</a></body></html>';
const fetchImpl = async url => new Response(
  String(url).endsWith("/kontakt") ? contactHtml : homeHtml,
  { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
);
const restaurants = [{ id: 7, name: "Gasthof am See", website: "https://restaurant.example/" }];

const progressUpdates = [];
const progressState = makeDb();
const progressReport = await runRestaurantWebsiteMonitor({
  db: progressState.db, restaurants, fetchImpl,
  onProgress: progress => progressUpdates.push(progress)
});
assert.equal(progressReport.pages, 2);
assert.ok(progressUpdates.length >= 2);
assert.equal(progressUpdates.at(-1).completed, 1);
assert.equal(progressUpdates.at(-1).total, 1);
assert.equal(progressUpdates.at(-1).pages, 2);

const baseline = await runRestaurantWebsiteMonitor({ db: dbState.db, restaurants, fetchImpl });
assert.equal(baseline.pages, 2);
assert.equal(baseline.baselines, 2);
assert.equal(baseline.proposals, 0);
assert.equal(dbState.proposals.size, 0);

const unchanged = await runRestaurantWebsiteMonitor({ db: dbState.db, restaurants, fetchImpl });
assert.equal(unchanged.proposals, 0);

contactHtml = '<html><body><h1>Kontakt</h1><p>Telefon: 08022 222222</p><p>E-Mail: info@example.de</p><p>Neue Telefonnummer ab sofort</p></body></html>';
const changed = await runRestaurantWebsiteMonitor({ db: dbState.db, restaurants, fetchImpl });
assert.equal(changed.proposals, 1);
assert.ok([...dbState.proposals.values()].some(row => row[1] === "telefon" && row[3] === "08022 222222"));
assert.ok(![...dbState.proposals.values()].some(row => row[1] === "website_text"));

contactHtml = '<html><body><script type="application/ld+json">{"@type":"Restaurant","telephone":"08022 333333"}</script><h1>Kontakt</h1><p>Telefon: 08022 222222</p><p>E-Mail: info@example.de</p><p>Neue Telefonnummer ab sofort</p></body></html>';
const structuredOnly = await runRestaurantWebsiteMonitor({ db: dbState.db, restaurants, fetchImpl });
assert.ok(structuredOnly.proposals >= 1);
assert.ok([...dbState.proposals.values()].some(row => row[1] === "telefon" && row[3] === "08022 333333"));


homeHtml = '<html><body><h1>Gasthof am See</h1><a href="/kontakt">Kontakt</a><p>{"inventory_management":"shopify","qty":92,"container":"card","can_show_preorder":false}</p><div>Skibrillen-Cover "Bräustüberl"</div></body></html>';
const irrelevantNoise = await runRestaurantWebsiteMonitor({ db: dbState.db, restaurants, fetchImpl });
assert.equal(irrelevantNoise.proposals, 0);
assert.ok(![...dbState.proposals.values()].some(row => row[1] === "website_text" || row[1] === "unterseiten"));

homeHtml = '<html><body><h1>Gasthof am See</h1><a href="/kontakt">Kontakt</a><a href="/speisekarte-neu.pdf">Speisekarte</a><a href="https://fremd.example/">Extern</a></body></html>';
const pdfLinkChange = await runRestaurantWebsiteMonitor({ db: dbState.db, restaurants, fetchImpl });
assert.ok(pdfLinkChange.proposals >= 1);
assert.ok([...dbState.proposals.values()].some(row => row[1] === "dokumente" && row[3].includes("speisekarte-neu.pdf")));

const unreachable = await runRestaurantWebsiteMonitor({
  db: dbState.db, restaurants,
  fetchImpl: async () => new Response("Fehler", { status: 503, headers: { "Content-Type": "text/html" } })
});
assert.equal(unreachable.pages, 0);
assert.equal(unreachable.errors.length, 1);

// Pages above the former 1 MB limit are now accepted up to the strict 3 MB cap.
const largeHtml = '<html><body><h1>Gasthof am See</h1>' + 'x'.repeat(1_200_000) + '</body></html>';
const largePage = await runRestaurantWebsiteMonitor({
  db: makeDb().db, restaurants,
  fetchImpl: async () => new Response(largeHtml, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
});
assert.equal(largePage.pages, 1);
assert.equal(largePage.errors.length, 0);

// HTML served with a generic content type is accepted only when its body looks like HTML.
const mislabeledHtml = await runRestaurantWebsiteMonitor({
  db: makeDb().db, restaurants,
  fetchImpl: async () => new Response('<!doctype html><html><body><h1>Gasthof</h1></body></html>', {
    status: 200, headers: { "Content-Type": "application/octet-stream" }
  })
});
assert.equal(mislabeledHtml.pages, 1);
assert.equal(mislabeledHtml.errors.length, 0);

// Explicit PDF responses remain excluded from HTML parsing.
const pdfResponse = await runRestaurantWebsiteMonitor({
  db: makeDb().db, restaurants,
  fetchImpl: async () => new Response("%PDF-1.7", { status: 200, headers: { "Content-Type": "application/pdf" } })
});
assert.equal(pdfResponse.pages, 0);
assert.equal(pdfResponse.errors.length, 1);

const entityState = makeDb();
let entityHome = '<html><body><h1>Firstalm</h1><a href="mailto:info&#64;firstalm&#46;de">E-Mail</a></body></html>';
const entityFetch = async () => new Response(entityHome, { status: 200, headers: { "Content-Type": "text/html" } });
await runRestaurantWebsiteMonitor({ db: entityState.db, restaurants, fetchImpl: entityFetch });
entityHome = '<html><body><h1>Firstalm</h1><a href="mailto:info&#064;firstalm&#046;de">E-Mail</a></body></html>';
const entityOnlyDifference = await runRestaurantWebsiteMonitor({ db: entityState.db, restaurants, fetchImpl: entityFetch });
assert.equal(entityOnlyDifference.proposals, 0, "Equivalent HTML-entity encodings must not create a false change");


// Contact-link comparisons ignore HTML entity encoding, whitespace, and ordering.
assert.equal(findRestaurantChanges(
  { externe_links: "+49 8029 386: tel:08029-386 0175/4307345&nbsp;: tel:0175/4307345\nTisch reservieren: https://example.de/book?step=date&amp;source=site" },
  { externe_links: "+49 8029 386: tel:08029-386 0175/4307345 : tel:0175/4307345\nTisch reservieren: https://example.de/book?source=site&step=date" }
).length, 0);

assert.equal(findRestaurantChanges(
  { externe_links: "E-Mail: mailto:info&#064;firstalm&#046;de\nSpeisekarte: https://example.de/menu" },
  { externe_links: "Speisekarte: https://example.de/menu\nE-Mail: mailto:info@firstalm.de" }
).length, 0);

assert.equal(findRestaurantChanges(
  { dokumente: "Speisekarte: https://example.de/menu.pdf?b=2&a=1\nGetränke: https://example.de/drinks.pdf" },
  { dokumente: "Getränke: https://example.de/drinks.pdf\nSpeisekarte: https://example.de/menu.pdf?a=1&b=2" }
).length, 0);

// A short network failure is retried once before the monitor records an error.
let retryCalls = 0;
const retryResult = await runRestaurantWebsiteMonitor({
  db: makeDb().db, restaurants,
  fetchImpl: async () => {
    retryCalls++;
    if (retryCalls === 1) throw new TypeError("temporary network failure");
    return new Response("<html><body><h1>Gasthof</h1></body></html>", {
      status: 200, headers: { "Content-Type": "text/html" }
    });
  }
});
assert.equal(retryResult.pages, 1);
assert.equal(retryResult.errors.length, 0);
assert.equal(retryCalls, 2);

// An official PDF menu makes a broken legacy HTML menu page unnecessary to crawl.
const menuFallback = await runRestaurantWebsiteMonitor({
  db: makeDb().db, restaurants,
  fetchImpl: async url => {
    if (String(url).endsWith("/speisekarte.html")) {
      return new Response("unavailable", { status: 503, headers: { "Content-Type": "text/html" } });
    }
    if (String(url).endsWith("/kontakt")) {
      return new Response("<html><body><h1>Kontakt</h1></body></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    }
    return new Response('<html><body><h1>Gasthof</h1><a href="/speisekarte.html">Speisekarte</a><a href="/speisekarte.pdf">Speisekarte PDF</a><a href="/kontakt">Kontakt</a></body></html>', {
      status: 200, headers: { "Content-Type": "text/html" }
    });
  }
});
assert.equal(menuFallback.errors.length, 0);
assert.equal(menuFallback.pages, 2);

// If a legacy contact.php endpoint fails, try its same-host .html equivalent.
const contactFallbackState = makeDb();
const contactFallback = await runRestaurantWebsiteMonitor({
  db: contactFallbackState.db, restaurants,
  fetchImpl: async url => {
    if (String(url).endsWith("/kontakt.php")) {
      return new Response("server error", { status: 500, headers: { "Content-Type": "text/html" } });
    }
    if (String(url).endsWith("/kontakt.html")) {
      return new Response("<html><body><h1>Kontakt</h1><p>Telefon: 08022 123456</p></body></html>", {
        status: 200, headers: { "Content-Type": "text/html" }
      });
    }
    return new Response('<html><body><h1>Gasthof</h1><a href="/kontakt.php">Kontakt</a></body></html>', {
      status: 200, headers: { "Content-Type": "text/html" }
    });
  }
});
assert.equal(contactFallback.errors.length, 0);
assert.equal(contactFallback.pages, 2);
assert.ok([...contactFallbackState.snapshots.keys()].some(key => key.endsWith("|https://restaurant.example/kontakt.html")));

console.log("Restaurant-Monitor-Lauf: Baseline, Änderungen, Fehler und HTML-Grenzfälle erfolgreich.");
