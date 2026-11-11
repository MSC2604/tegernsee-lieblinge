// Isolierter Helfer für die spätere tägliche Restaurant-Datenprüfung.
// Noch nicht in worker.js eingebunden und nicht produktiv aktiv.
function clean(value) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).replace(/\s+/g, " ").trim();
  }
  return "";
}

function typeIsRestaurant(value) {
  const types = Array.isArray(value) ? value : [value];
  return types.some(type =>
    /(?:Restaurant|FoodEstablishment|LocalBusiness)$/i.test(String(type || ""))
  );
}

function flattenJsonLd(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, output);
    return output;
  }
  output.push(value);
  if (value["@graph"]) flattenJsonLd(value["@graph"], output);
  return output;
}

function addressText(address) {
  if (typeof address === "string") return clean(address);
  if (!address || typeof address !== "object") return "";
  return [
    clean(address.streetAddress),
    [clean(address.postalCode), clean(address.addressLocality)].filter(Boolean).join(" ")
  ].filter(Boolean).join(", ");
}

function openingHoursText(item) {
  const simple = Array.isArray(item.openingHours)
    ? item.openingHours.map(clean).filter(Boolean).join("; ")
    : clean(item.openingHours);
  if (simple) return simple;

  const specs = Array.isArray(item.openingHoursSpecification)
    ? item.openingHoursSpecification
    : item.openingHoursSpecification ? [item.openingHoursSpecification] : [];
  const rows = specs.map(spec => {
    if (!spec || typeof spec !== "object") return "";
    const days = (Array.isArray(spec.dayOfWeek) ? spec.dayOfWeek : [spec.dayOfWeek])
      .map(day => clean(day).split("/").pop())
      .filter(Boolean);
    const opens = clean(spec.opens), closes = clean(spec.closes);
    if (!days.length || !opens || !closes) return "";
    return days.join(", ") + " " + opens + "–" + closes;
  }).filter(Boolean);
  return rows.join("; ");
}

export function extractRestaurantData(html) {
  const scripts = String(html || "").match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  const candidates = [];
  for (const script of scripts) {
    const json = script.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "");
    try { candidates.push(...flattenJsonLd(JSON.parse(json))); } catch { /* ungültige JSON-LD-Blöcke ignorieren */ }
  }

  const restaurant = candidates.find(item => typeIsRestaurant(item["@type"]));
  if (!restaurant) return {};

  const values = {
    telefon: clean(restaurant.telephone),
    email: clean(restaurant.email),
    website: clean(restaurant.url),
    adresse: addressText(restaurant.address),
    oeffnungszeiten: openingHoursText(restaurant)
  };
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value.length > 0)
  );
}

function normalize(field, value) {
  const text = clean(value).toLocaleLowerCase("de");
  if (field === "telefon") return text.replace(/[\s()./-]/g, "");
  if (field === "email" || field === "website") return text.replace(/\/$/, "");
  return text.replace(/[\s]+/g, " ");
}

export function findRestaurantChanges(current, found) {
  const changes = [];
  for (const [field, newValue] of Object.entries(found || {})) {
    const oldValue = clean(current?.[field]);
    const nextValue = clean(newValue);
    if (!nextValue || normalize(field, oldValue) === normalize(field, nextValue)) continue;
    changes.push({ field, oldValue, newValue: nextValue });
  }
  return changes;
}
