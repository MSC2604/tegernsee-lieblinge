// Isolierter Helfer für die spätere tägliche Restaurant-Datenprüfung.
// Noch nicht in worker.js eingebunden und nicht produktiv aktiv.
function clean(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\s+/g, ' ').trim() : '';
}
function typeIsRestaurant(value) {
  const types = Array.isArray(value) ? value : [value];
  return types.some(type => /(?:Restaurant|FoodEstablishment|LocalBusiness)$/i.test(String(type || '')));
}
function flattenJsonLd(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) { for (const item of value) flattenJsonLd(item, output); return output; }
  output.push(value); if (value['@graph']) flattenJsonLd(value['@graph'], output); return output;
}
function addressText(address) {
  if (typeof address === 'string') return clean(address);
  if (!address || typeof address !== 'object') return '';
  return [clean(address.streetAddress), [clean(address.postalCode), clean(address.addressLocality)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}
function openingHoursText(item) {
  const simple = Array.isArray(item.openingHours) ? item.openingHours.map(clean).filter(Boolean).join('; ') : clean(item.openingHours);
  if (simple) return simple;
  const specs = Array.isArray(item.openingHoursSpecification) ? item.openingHoursSpecification : item.openingHoursSpecification ? [item.openingHoursSpecification] : [];
  return specs.map(spec => {
    if (!spec || typeof spec !== 'object') return '';
    const days = (Array.isArray(spec.dayOfWeek) ? spec.dayOfWeek : [spec.dayOfWeek]).map(day => clean(day).split('/').pop()).filter(Boolean);
    const opens = clean(spec.opens), closes = clean(spec.closes);
    return days.length && opens && closes ? days.join(', ') + ' ' + opens + '–' + closes : '';
  }).filter(Boolean).join('; ');
}
export function extractPageText(html) {
  return String(html || '').replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<br\s*\/?\s*>|<\/(p|div|li|tr|h[1-6]|section|article)>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim().slice(0, 50000);
}
export function extractRestaurantData(html) {
  const source = String(html || '');
  const scripts = source.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  const candidates = [];
  for (const script of scripts) {
    const json = script.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '');
    try { candidates.push(...flattenJsonLd(JSON.parse(json))); } catch { /* invalid JSON-LD */ }
  }
  const restaurant = candidates.find(item => typeIsRestaurant(item['@type'])) || {};
  const text = extractPageText(source);
  const phone = text.match(/(?:Telefon|Tel\.?|Phone)\s*[:：]?\s*(\+?\s*\d[\d\s()./-]{5,}\d)/i);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const hours = text.match(/(?:Öffnungszeiten|Oeffnungszeiten)\s*[:：]?\s*([^.!?]{8,180})/i);
  const dayOff = text.match(/(?:Ruhetag|Ruhetage)\s*[:：]?\s*([A-Za-zÄÖÜäöüß ,/-]{3,60}?)(?=\s+(?:Betriebsferien|Öffnungszeiten|Telefon|Tel\.?|E-Mail)\b|$)/i);
  const holidays = text.match(/(?:Betriebsferien|Urlaub|geschlossen vom)\s*[:：]?\s*(.{4,100}?)(?=\s+(?:Öffnungszeiten|Ruhetag|Telefon|Tel\.?|E-Mail|Adresse)\b|$)/i);
  const values = {
    telefon: clean(restaurant.telephone) || (phone ? clean(phone[1]) : ''),
    email: clean(restaurant.email) || (email ? clean(email[0]) : ''),
    website: clean(restaurant.url),
    adresse: addressText(restaurant.address),
    oeffnungszeiten: openingHoursText(restaurant) || (hours ? clean(hours[1]) : ''),
    ruhetag: dayOff ? clean(dayOff[1]) : '',
    betriebsferien: holidays ? clean(holidays[1]) : ''
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value.length > 0));
}
function normalize(field, value) {
  const text = clean(value).toLocaleLowerCase('de');
  if (field === 'telefon') return text.replace(/[\s()./-]/g, '');
  if (field === 'email' || field === 'website') return text.replace(/\/$/, '');
  return text.replace(/\s+/g, ' ');
}
export function findRestaurantChanges(current, found) {
  const changes = [];
  const fields = new Set([
    ...Object.keys(current || {}),
    ...Object.keys(found || {})
  ]);
  for (const field of fields) {
    const oldValue = clean(current?.[field]);
    const nextValue = clean(found?.[field]);
    if (oldValue && !nextValue) {
      changes.push({ field, oldValue, newValue: "Nicht mehr angegeben" });
      continue;
    }
    if (!nextValue || normalize(field, oldValue) === normalize(field, nextValue)) continue;
    changes.push({ field, oldValue, newValue: nextValue });
  }
  return changes;
}

export function extractOfficialPageLinks(html, baseUrl, limit = 10) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  if (!["http:", "https:"].includes(base.protocol)) return [];
  const candidates = [];
  const seen = new Set([base.href]);
  const matches = String(html || "").matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  const priority = /(öffnungszeit|oeffnungszeit|zeiten|kontakt|anfahrt|speisekarte|getränkekarte|getraenkekarte|menü|menu|karte|betriebsferien|urlaub|geschlossen|aktuelles|news|impressum|reservierung)/i;
  const ignored = /(datenschutz|privacy|cookie|barrierefreiheit|facebook|instagram|youtube|newsletter|login|warenkorb)/i;
  for (const match of matches) {
    try {
      const url = new URL(match[1], base.href);
      if (url.origin !== base.origin || !["http:", "https:"].includes(url.protocol)) continue;
      if (/\.(?:pdf|jpg|jpeg|png|webp|gif|zip|mp4|mp3)(?:$|\?)/i.test(url.pathname + url.search)) continue;
      url.hash = "";
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const label = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const hint = url.pathname + " " + label;
      if (ignored.test(hint) && !/impressum/i.test(hint)) continue;
      candidates.push({ url: url.href, score: priority.test(hint) ? 2 : 1 });
    } catch { /* ungültige Links überspringen */ }
  }
  candidates.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return candidates.slice(0, Math.max(1, Math.min(20, limit))).map(item => item.url);
}


export function extractOfficialDocumentLinks(html, baseUrl, limit = 20) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  if (!["http:", "https:"].includes(base.protocol)) return [];
  const found = [];
  const seen = new Set();
  const matches = String(html || "").matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  for (const match of matches) {
    try {
      const url = new URL(match[1], base.href);
      if (url.origin !== base.origin || !/\.pdf(?:$|\?)/i.test(url.pathname + url.search)) continue;
      url.hash = "";
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const label = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      found.push((label ? label + ": " : "") + url.href);
      if (found.length >= Math.max(1, Math.min(50, limit))) break;
    } catch { /* ungültige Dokumentlinks überspringen */ }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

export async function fingerprintPage(html, extractedData = null) {
  const canonical = extractPageText(html) + "\\n" + JSON.stringify(extractedData || {});
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
