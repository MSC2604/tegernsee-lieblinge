// Isolierter Helfer für die spätere tägliche Restaurant-Datenprüfung.
// Wird nur vom isolierten Entwicklungszweig-Worker verwendet; main bleibt unverändert.
function clean(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\s+/g, ' ').trim() : '';
}
function decodeHtmlEntities(value) {
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|nbsp|commat|period|colon);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key === "amp") return "&";
    if (key === "quot") return '"';
    if (key === "apos") return "'";
    if (key === "nbsp") return " ";
    if (key === "commat") return "@";
    if (key === "period") return ".";
    if (key === "colon") return ":";
    const code = key.startsWith("#x") ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
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
  return decodeHtmlEntities(String(html || '').replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<br\s*\/?\s*>|<\/(p|div|li|tr|h[1-6]|section|article)>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 50000);
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
  const email = text.match(/(?:E-?Mail|Email(?:adresse)?)\s*[:：]?\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  const hours = text.match(/(?:Öffnungszeiten|Oeffnungszeiten)\s*[:：]?\s*(.{8,220}?)(?=\s+(?:Ruhetag|Telefon|Tel\.?|E-Mail|Adresse|Betriebsferien)\b|$)/i);
  const dayOff = text.match(/(?:Ruhetag|Ruhetage)\s*[:：]?\s*([A-Za-zÄÖÜäöüß ,/-]{3,60}?)(?=\s+(?:Betriebsferien|Öffnungszeiten|Telefon|Tel\.?|E-Mail)\b|$)/i);
  const address = text.match(/(?:Adresse|Anschrift)\s*[:：]?\s*(.{6,140}?)(?=\s+(?:Telefon|Tel\.?|E-Mail|Öffnungszeiten|Ruhetag)\b|$)/i);
  const holidays = text.match(/(?:Betriebsferien|Urlaub|geschlossen vom)\s*[:：]?\s*(.{4,100}?)(?=\s+(?:Öffnungszeiten|Ruhetag|Telefon|Tel\.?|E-Mail|Adresse)\b|$)/i);
  const values = {
    telefon: clean(restaurant.telephone) || (phone ? clean(phone[1]) : ''),
    email: clean(restaurant.email) || (email ? clean(email[1]) : ''),
    website: clean(restaurant.url),
    adresse: addressText(restaurant.address) || (address ? clean(address[1]) : ''),
    oeffnungszeiten: openingHoursText(restaurant) || (hours ? clean(hours[1]) : ''),
    ruhetag: dayOff ? clean(dayOff[1]) : '',
    betriebsferien: holidays ? clean(holidays[1]) : ''
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value.length > 0));
}
const MONITORED_FIELDS = new Set([
  'telefon', 'email', 'website', 'adresse',
  'oeffnungszeiten', 'ruhetag', 'betriebsferien',
  'dokumente', 'externe_links'
]);
function normalizeLinkEntry(entry) {
  const value = decodeHtmlEntities(entry).replace(/[\s\u00a0]+/g, ' ').trim();
  // Labels, entity encoding and mail-client subject/body text are presentation
  // details. Compare every destination in a line, not just the first one.
  const matches = [...value.matchAll(/(?:https?:\/\/|mailto:|tel:)[^\s<>"']+/gi)];
  if (!matches.length) return value.toLocaleLowerCase('de');
  const normalized = matches.map(match => {
    const raw = match[0];
    const trailing = raw.match(/[),.;]+$/)?.[0] || '';
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
    if (/^mailto:/i.test(candidate)) {
      try {
        const url = new URL(candidate);
        return 'mailto:' + decodeURIComponent(url.pathname || '').toLocaleLowerCase('de');
      } catch { return candidate.toLocaleLowerCase('de').split('?')[0]; }
    }
    if (/^tel:/i.test(candidate)) {
      try {
        const number = decodeURIComponent(candidate.slice(4)).replace(/[^+\d]/g, '');
        return 'tel:' + number;
      } catch { return 'tel:' + candidate.slice(4).replace(/[^+\d]/g, ''); }
    }
    try {
      const url = new URL(candidate);
      url.hash = '';
      if ((url.protocol === 'https:' && url.port === '443') ||
          (url.protocol === 'http:' && url.port === '80')) url.port = '';
      for (const key of [...url.searchParams.keys()]) {
        if (/^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
      }
      const params = [...url.searchParams.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
      url.search = '';
      for (const [key, val] of params) url.searchParams.append(key, val);
      // Hostnames are normalized; case-sensitive path and meaningful query
      // values remain intact.
      return url.href;
    } catch { return candidate + trailing; }
  });
  return [...new Set(normalized)].sort((a, b) => a.localeCompare(b, 'de')).join(' | ');
}
function normalize(field, value) {
  const decoded = decodeHtmlEntities(
    (field === 'dokumente' || field === 'externe_links')
      ? String(value ?? '').replace(/\\r\\n?/g, '\\n').trim()
      : clean(value)
  );
  const text = decoded.toLocaleLowerCase('de');
  if (field === 'telefon') return text.replace(/[^+\d]/g, '');
  if (field === 'email') return text.replace(/[\s\u00a0]+/g, '');
  if (field === 'website') {
    try {
      const url = new URL(decoded);
      url.hash = '';
      if ((url.protocol === 'https:' && url.port === '443') ||
          (url.protocol === 'http:' && url.port === '80')) url.port = '';
      return url.href.toLocaleLowerCase('de').replace(/\/$/, '');
    } catch { return text.replace(/\/$/, ''); }
  }
  if (field === 'dokumente' || field === 'externe_links') {
    return [...new Set(decoded.split(/\r?\n/).map(normalizeLinkEntry).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'de')).join('\n');
  }
  return text
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\s]+/g, ' ')
    .trim();
}
export function findRestaurantChanges(current, found) {
  const changes = [];
  // Only compare explicitly relevant restaurant facts and links.
  // A missing field is not evidence that a business removed the information.
  for (const field of MONITORED_FIELDS) {
    const preserveLines = field === 'dokumente' || field === 'externe_links';
    const oldValue = preserveLines ? String(current?.[field] ?? '').trim() : clean(current?.[field]);
    const nextValue = preserveLines ? String(found?.[field] ?? '').trim() : clean(found?.[field]);
    if (!nextValue) continue;
    if (normalize(field, oldValue) === normalize(field, nextValue)) continue;
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
      const url = new URL(decodeHtmlEntities(match[1]), base.href);
      if (url.origin !== base.origin || !["http:", "https:"].includes(url.protocol)) continue;
      if (/\.(?:pdf|jpg|jpeg|png|webp|gif|zip|mp4|mp3)(?:$|\?)/i.test(url.pathname + url.search)) continue;
      url.hash = "";
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const label = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
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
      const url = new URL(decodeHtmlEntities(match[1]), base.href);
      if (url.origin !== base.origin || !/\.pdf(?:$|\?)/i.test(url.pathname + url.search)) continue;
      url.hash = "";
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const label = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      found.push((label ? label + ": " : "") + url.href);
      if (found.length >= Math.max(1, Math.min(50, limit))) break;
    } catch { /* ungültige Dokumentlinks überspringen */ }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

export function extractRelevantExternalLinks(html, baseUrl, limit = 30) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  if (!["http:", "https:"].includes(base.protocol)) return [];
  const found = [];
  const seen = new Set();
  const relevant = /(reserv|tisch|booking|speisekarte|getränkekarte|getraenkekarte|menü|menu|karte|kontakt|telefon|tel\b|route|anfahrt|pdf|mail)/i;
  const matches = String(html || "").matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  for (const match of matches) {
    try {
      const raw = decodeHtmlEntities(match[1].trim());
      const url = new URL(raw, base.href);
      const isContact = ["mailto:", "tel:"].includes(url.protocol);
      if (!isContact && (!["http:", "https:"].includes(url.protocol) || url.origin === base.origin)) continue;
      const label = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      if (!relevant.test(label + " " + url.href)) continue;
      const value = (label ? label + ": " : "") + url.href;
      if (seen.has(value)) continue;
      seen.add(value);
      found.push(value);
      if (found.length >= Math.max(1, Math.min(50, limit))) break;
    } catch { /* ungültige Links überspringen */ }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

export async function fingerprintPage(html, extractedData = null) {
  const canonical = extractPageText(html) + "\\n" + JSON.stringify(extractedData || {});
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
