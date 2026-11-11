// Isolierter Lauf der offiziellen Website-Prüfung.
// Wird erst nach ausdrücklicher Freigabe in den Live-Worker eingebunden.
import {
  extractOfficialPageLinks,
  extractPageText,
  extractRestaurantData,
  findRestaurantChanges,
  fingerprintPage
} from "./restaurant-monitor.mjs";

const MAX_BYTES = 1024 * 1024;
const MAX_PAGES = 6;
const TIMEOUT_MS = 8000;

function textArg(value) {
  return { type: "text", value: value == null ? "" : String(value) };
}
function cell(value) {
  if (value == null) return "";
  return typeof value === "object" && "value" in value ? value.value : value;
}
function safeHttpUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1" ||
      host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:") ||
      host === "169.254.169.254") return null;
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
      throw new Error("Website-Seite ist größer als 1 MB.");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function changedExcerpt(oldText, newText) {
  let index = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (index < maxPrefix && oldText[index] === newText[index]) index++;
  const start = Math.max(0, index - 180);
  const oldEnd = Math.min(oldText.length, index + 520);
  const newEnd = Math.min(newText.length, index + 520);
  return {
    oldValue: oldText.slice(start, oldEnd),
    newValue: newText.slice(start, newEnd)
  };
}

async function fetchOfficialHtml(rawUrl, origin, fetchImpl) {
  let current = rawUrl;
  for (let hop = 0; hop <= 3; hop++) {
    const url = safeHttpUrl(current);
    if (!url || url.origin !== origin) throw new Error("Weiterleitung außerhalb der offiziellen Website blockiert.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchImpl(url.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "TegernseeRestaurantWebsiteMonitor/1.0",
          "Accept": "text/html,application/xhtml+xml;q=0.9"
        }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("Location");
        if (!location || hop === 3) throw new Error("Weiterleitung nicht auflösbar.");
        current = new URL(location, url.href).href;
        continue;
      }
      if (!response.ok) throw new Error("Website antwortet mit HTTP " + response.status + ".");
      const type = response.headers.get("Content-Type") || "";
      if (!type.toLowerCase().includes("text/html") && !type.toLowerCase().includes("application/xhtml+xml")) {
        throw new Error("Die verlinkte Seite liefert kein HTML.");
      }
      return await readLimited(response);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Zu viele Weiterleitungen.");
}

export async function runRestaurantWebsiteMonitor({
  db,
  restaurants,
  fetchImpl = fetch,
  now = () => new Date().toISOString()
}) {
  if (typeof db !== "function") throw new Error("Datenbankfunktion fehlt.");
  const report = { restaurants: 0, pages: 0, baselines: 0, proposals: 0, errors: [] };
  const processRestaurant = async restaurant => {
    const id = String(restaurant?.id ?? "").trim();
    const website = String(restaurant?.website ?? "").trim();
    if (!id || !website) return;
    const root = safeHttpUrl(website);
    if (!root) {
      report.errors.push({ restaurantId: id, name: String(restaurant.name || ""), error: "Website-Adresse ist ungültig oder aus Sicherheitsgründen gesperrt." });
      return;
    }
    report.restaurants++;
    let homepage;
    try {
      homepage = await fetchOfficialHtml(root.href, root.origin, fetchImpl);
    } catch (error) {
      report.errors.push({ restaurantId: id, name: String(restaurant.name || ""), url: root.href, error: String(error?.message || error).slice(0, 220) });
      return;
    }
    const pages = [root.href, ...extractOfficialPageLinks(homepage, root.href, MAX_PAGES - 1)];
    for (const pageUrl of pages) {
      let html;
      try {
        html = pageUrl === root.href ? homepage : await fetchOfficialHtml(pageUrl, root.origin, fetchImpl);
      } catch (error) {
        report.errors.push({ restaurantId: id, name: String(restaurant.name || ""), url: pageUrl, error: String(error?.message || error).slice(0, 220) });
        continue;
      }
      const pageText = extractPageText(html);
      if (!pageText) continue;
      const hash = await fingerprintPage(html);
      const found = extractRestaurantData(html);
      const oldResult = await db(
        "SELECT content_hash, extracted_data_json, content_text FROM restaurant_site_snapshots WHERE restaurant_id = ? AND page_url = ?",
        [textArg(id), textArg(pageUrl)], true
      );
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
          await db(
            "INSERT OR IGNORE INTO restaurant_change_proposals (restaurant_id, field_name, old_value, new_value, source_url, detected_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
            [textArg(id), textArg(change.field), textArg(change.oldValue), textArg(change.newValue), textArg(pageUrl), textArg(stamp)]
          );
          report.proposals++;
        }
        if (oldText !== pageText) {
          const excerpt = changedExcerpt(oldText, pageText);
          await db(
            "INSERT OR IGNORE INTO restaurant_change_proposals (restaurant_id, field_name, old_value, new_value, source_url, detected_at, status) VALUES (?, 'website_text', ?, ?, ?, ?, 'pending')",
            [textArg(id), textArg(excerpt.oldValue), textArg(excerpt.newValue), textArg(pageUrl), textArg(stamp)]
          );
          report.proposals++;
        }
      }
      await db(
        `INSERT INTO restaurant_site_snapshots (restaurant_id, page_url, checked_at, content_hash, extracted_data_json, content_text)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(restaurant_id, page_url) DO UPDATE SET
           checked_at=excluded.checked_at,
           content_hash=excluded.content_hash,
           extracted_data_json=excluded.extracted_data_json,
           content_text=excluded.content_text`,
        [textArg(id), textArg(pageUrl), textArg(stamp), textArg(hash), textArg(JSON.stringify(found)), textArg(pageText.slice(0, 50000))]
      );
      report.pages++;
    }
  };

  const list = Array.isArray(restaurants) ? restaurants : [];
  for (let i = 0; i < list.length; i += 4) {
    await Promise.all(list.slice(i, i + 4).map(async restaurant => {
      try {
        await processRestaurant(restaurant);
      } catch (error) {
        report.errors.push({
          restaurantId: String(restaurant?.id ?? ""),
          name: String(restaurant?.name || ""),
          error: String(error?.message || error).slice(0, 220)
        });
      }
    }));
  }
  return report;
}
