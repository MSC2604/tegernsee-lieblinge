// Isolierter Lauf der offiziellen Website-Prüfung.
// Wird erst nach ausdrücklicher Freigabe in den Live-Worker eingebunden.
import {
  extractOfficialPageLinks,
  extractOfficialDocumentLinks,
  extractRelevantExternalLinks,
  extractPageText,
  extractRestaurantData,
  findRestaurantChanges,
  fingerprintPage
} from "./restaurant-monitor.mjs";

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_PAGES = 6;
const TIMEOUT_MS = 15000;
const FETCH_ATTEMPTS = 2;

function textArg(value) {
  return { type: "text", value: value == null ? "" : String(value) };
}
function cell(value) {
  if (value == null) return "";
  return typeof value === "object" && "value" in value ? value.value : value;
}
function safeHttpUrl(raw) {
  let url;
  const input = String(raw || "").trim();
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : "https://" + input);
  } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) ||
      /^224\./.test(host) || /^240\./.test(host) || host === "0.0.0.0" ||
      host === "::1" || host.startsWith("::ffff:") ||
      host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:") ||
      host.startsWith("ff") || host === "169.254.169.254") return null;
  return url;
}

async function readLimited(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Antwortinhalt nicht lesbar.");
  const chunks = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error("Website-Seite ist größer als 3 MB.");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}


async function fetchOfficialHtml(rawUrl, origin, fetchImpl) {
  let current = rawUrl;
  for (let hop = 0; hop <= 3; hop++) {
    const url = safeHttpUrl(current);
    if (!url || url.origin !== origin) throw new Error("Weiterleitung außerhalb der offiziellen Website blockiert.");
    let response;
    let lastError;
    let activeTimer;
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      activeTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        response = await fetchImpl(url.href, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent": "TegernseeRestaurantWebsiteMonitor/1.0",
            "Accept": "text/html,application/xhtml+xml;q=0.9"
          }
        });
        break;
      } catch (error) {
        clearTimeout(activeTimer);
        lastError = error;
        if (attempt === FETCH_ATTEMPTS) throw error;
      }
    }
    if (!response) throw lastError || new Error("Website konnte nicht abgerufen werden.");
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("Location");
        if (!location || hop === 3) throw new Error("Weiterleitung nicht auflösbar.");
        current = new URL(location, url.href).href;
        continue;
      }
      if (!response.ok) throw new Error("Website antwortet mit HTTP " + response.status + ".");
      const type = (response.headers.get("Content-Type") || "").toLowerCase();
      // Some hosts mislabel HTML as text/plain or application/octet-stream.
      // Read it with the same strict size cap and verify the actual document
      // before parsing; explicit binary media types are rejected immediately.
      if (/^(application\/(?:pdf|zip)|image\/|audio\/|video\/)/i.test(type)) {
        throw new Error("Die verlinkte Seite liefert kein HTML.");
      }
      const html = await readLimited(response);
      if (type.includes("text/html") || type.includes("application/xhtml+xml") ||
          /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(html)) {
        return html;
      }
      throw new Error("Die verlinkte Seite liefert kein HTML.");
    } finally {
      clearTimeout(activeTimer);
    }
  }
  throw new Error("Zu viele Weiterleitungen.");
}

export async function runRestaurantWebsiteMonitor({
  db,
  restaurants,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  onProgress
}) {
  if (typeof db !== "function") throw new Error("Datenbankfunktion fehlt.");
  const list = Array.isArray(restaurants) ? restaurants : [];
  const report = { restaurants: 0, pages: 0, baselines: 0, proposals: 0, errors: [] };
  let completed = 0;
  const active = new Set();
  let progressQueue = Promise.resolve();
  const publishProgress = () => {
    if (typeof onProgress !== "function") return progressQueue;
    const snapshot = { phase: "running", completed, total: list.length, activeRestaurants: [...active], restaurants: report.restaurants, pages: report.pages, baselines: report.baselines, proposals: report.proposals, errors: report.errors.length };
    progressQueue = progressQueue.then(() => onProgress(snapshot)).catch(error => {
      console.error("Website-Monitor-Fortschritt konnte nicht gespeichert werden:", String(error?.message || error));
    });
    return progressQueue;
  };
  await publishProgress();
  const processRestaurant = async restaurant => {
    const id = String(restaurant?.id ?? "").trim();
    const website = String(restaurant?.website ?? "").trim();
    if (!id || !website) return;
    active.add(String(restaurant.name || "Restaurant"));
    let root = safeHttpUrl(website);
    if (!root) {
      report.errors.push({ restaurantId: id, name: String(restaurant.name || ""), error: "Website-Adresse ist ungültig oder aus Sicherheitsgründen gesperrt." });
      return;
    }
    report.restaurants++;
    let homepage;
    try {
      homepage = await fetchOfficialHtml(root.href, root.origin, fetchImpl);
    } catch (error) {
      // Some older directory entries still use HTTP although the same official
      // host now serves HTTPS. Retry the secure origin before recording a fault.
      if (root.protocol === "http:") {
        const secureRoot = new URL(root.href);
        secureRoot.protocol = "https:";
        try {
          homepage = await fetchOfficialHtml(secureRoot.href, secureRoot.origin, fetchImpl);
          root = secureRoot;
        } catch {
          report.errors.push({ restaurantId: id, name: String(restaurant.name || ""), url: root.href, error: String(error?.message || error).slice(0, 220) });
          return;
        }
      } else {
        report.errors.push({ restaurantId: id, name: String(restaurant.name || ""), url: root.href, error: String(error?.message || error).slice(0, 220) });
        return;
      }
    }
    const homepageDocuments = extractOfficialDocumentLinks(homepage, root.href);
    const hasMenuPdf = homepageDocuments.some(item => /(speisekarte|getränkekarte|getraenkekarte|menü|menu|karte)/i.test(item));
    const discoveredPages = extractOfficialPageLinks(homepage, root.href, MAX_PAGES - 1);
    // If the homepage already exposes an official menu PDF, avoid crawling a
    // parallel legacy HTML menu endpoint that often returns broken/empty HTML.
    const pages = [root.href, ...discoveredPages.filter(pageUrl =>
      !(hasMenuPdf && /(?:speisekarte|getränkekarte|getraenkekarte|menu|menue|karte)/i.test(new URL(pageUrl).pathname))
    )];
    const processPage = async (pageUrl, knownHtml, fetchError = null) => {
      let html = knownHtml;
      let effectiveUrl = pageUrl;
      try {
        if (fetchError) throw fetchError;
        if (html == null) html = await fetchOfficialHtml(pageUrl, root.origin, fetchImpl);
      } catch (error) {
        // Some older sites have a broken PHP contact endpoint but retain the
        // equivalent static HTML page. Keep the fallback within the same host.
        if (/\/kontakt\.php(?:$|[?#])/i.test(pageUrl)) {
          const fallbackUrl = new URL(pageUrl);
          fallbackUrl.pathname = fallbackUrl.pathname.replace(/\.php$/i, ".html");
          try {
            html = await fetchOfficialHtml(fallbackUrl.href, root.origin, fetchImpl);
            effectiveUrl = fallbackUrl.href;
          } catch { /* report the original endpoint failure below */ }
        }
        if (html == null) {
          // Some restaurants expose their menu as a PDF behind a legacy
          // .html URL. It is a document, not a broken HTML page; skip it
          // without reporting a crawl error (PDF links remain separate data).
          const isMenuEndpoint = /(?:speisekarte|getränkekarte|getraenkekarte|menu|menue|karte)/i.test(new URL(pageUrl).pathname);
          const isNonHtml = /liefert kein HTML/i.test(String(error?.message || ""));
          if (isMenuEndpoint && isNonHtml) return;
          report.errors.push({ restaurantId: id, name: String(restaurant.name || ""), url: pageUrl, error: String(error?.message || error).slice(0, 220) });
          return;
        }
      }
      const pageText = extractPageText(html);
      if (!pageText) return;
      const found = extractRestaurantData(html);
      const documents = extractOfficialDocumentLinks(html, effectiveUrl);
      if (documents.length) found.dokumente = documents.join("\n");
      const externalLinks = extractRelevantExternalLinks(html, effectiveUrl);
      if (externalLinks.length) found.externe_links = externalLinks.join("\n");
      const hash = await fingerprintPage(html, found);
      const oldResult = await db("SELECT content_hash, extracted_data_json, content_text FROM restaurant_site_snapshots WHERE restaurant_id = ? AND page_url = ?", [textArg(id), textArg(effectiveUrl)], true);
      const oldRow = oldResult?.results?.[0]?.response?.result?.rows?.[0];
      const oldHash = oldRow ? String(cell(oldRow[0]) || "") : "";
      let oldData = {};
      try { oldData = JSON.parse(String(cell(oldRow?.[1]) || "{}")); } catch {}
      const oldText = String(cell(oldRow?.[2]) || "");
      const stamp = now();
      if (!oldRow) {
        report.baselines++;
      } else if (oldHash && oldHash !== hash) {
        const changes = findRestaurantChanges(oldData, found);
        for (const change of changes) {
          await db("INSERT OR IGNORE INTO restaurant_change_proposals (restaurant_id, field_name, old_value, new_value, source_url, detected_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')", [textArg(id), textArg(change.field), textArg(change.oldValue), textArg(change.newValue), textArg(effectiveUrl), textArg(stamp)]);
          report.proposals++;
        }
      }
      await db("INSERT INTO restaurant_site_snapshots (restaurant_id, page_url, checked_at, content_hash, extracted_data_json, content_text) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(restaurant_id, page_url) DO UPDATE SET checked_at=excluded.checked_at, content_hash=excluded.content_hash, extracted_data_json=excluded.extracted_data_json, content_text=excluded.content_text", [textArg(id), textArg(effectiveUrl), textArg(stamp), textArg(hash), textArg(JSON.stringify(found)), textArg(pageText.slice(0, 50000))]);
      report.pages++;
    };
    // Homepage first to discover subpages. Fetch up to three subpages in parallel,
    // but process their snapshots/proposals sequentially to avoid concurrent DB writes.
    await processPage(root.href, homepage);
    const subpages = pages.slice(1);
    for (let i = 0; i < subpages.length; i += 3) {
      const batch = subpages.slice(i, i + 3);
      const fetched = await Promise.all(batch.map(async pageUrl => {
        try {
          return { pageUrl, html: await fetchOfficialHtml(pageUrl, root.origin, fetchImpl), error: null };
        } catch (error) {
          return { pageUrl, html: null, error };
        }
      }));
      for (const item of fetched) {
        await processPage(item.pageUrl, item.html, item.error);
      }
    }
  };

  for (let i = 0; i < list.length; i += 4) {
    await Promise.all(list.slice(i, i + 4).map(async restaurant => {
      const name = String(restaurant?.name || "Restaurant");
      try {
        await processRestaurant(restaurant);
      } catch (error) {
        report.errors.push({ restaurantId: String(restaurant?.id ?? ""), name, error: String(error?.message || error).slice(0, 220) });
      } finally {
        active.delete(name);
        completed++;
        await publishProgress();
      }
    }));
  }
  return report;
}
