import assert from "node:assert/strict";
import { runRestaurantWebsiteMonitor } from "./restaurant-monitor-runner.mjs";

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
const progressReport = await runRestaurantWebsiteMonitor({
  db: dbState.db, restaurants, fetchImpl,
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
assert.ok(changed.proposals >= 2);
assert.ok([...dbState.proposals.values()].some(row => row[1] === "telefon" && row[3] === "08022 222222"));
assert.ok([...dbState.proposals.values()].some(row => row[1] === "website_text"));

contactHtml = '<html><body><script type="application/ld+json">{"@type":"Restaurant","telephone":"08022 333333"}</script><h1>Kontakt</h1><p>Telefon: 08022 222222</p><p>E-Mail: info@example.de</p><p>Neue Telefonnummer ab sofort</p></body></html>';
const structuredOnly = await runRestaurantWebsiteMonitor({ db: dbState.db, restaurants, fetchImpl });
assert.ok(structuredOnly.proposals >= 1);
assert.ok([...dbState.proposals.values()].some(row => row[1] === "telefon" && row[3] === "08022 333333"));

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
console.log("Restaurant-Monitor-Lauf: Baseline, unveränderte Seite, Änderung und Fehlerfall erfolgreich.");
