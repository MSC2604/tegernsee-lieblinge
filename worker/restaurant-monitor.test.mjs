import assert from "node:assert/strict";
import { extractRestaurantData, findRestaurantChanges } from "./restaurant-monitor.mjs";

const html = `
<script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@type":"Restaurant",
  "telephone":"+49 8022 12345",
  "email":"info@example.de",
  "address":{"@type":"PostalAddress","streetAddress":"Seestraße 4","postalCode":"83700","addressLocality":"Tegernsee"},
  "openingHoursSpecification":[
    {"dayOfWeek":["Monday"],"opens":"11:00","closes":"22:00"}
  ]
}
</script>`;
const found = extractRestaurantData(html);
assert.equal(found.telefon, "+49 8022 12345");
assert.equal(found.adresse, "Seestraße 4, 83700 Tegernsee");
assert.equal(found.oeffnungszeiten, "Monday 11:00–22:00");
assert.equal(findRestaurantChanges({ telefon:"+49 (0)8022 12345" }, found).length, 0);
assert.deepEqual(
  findRestaurantChanges({ telefon:"08022 99999" }, found).map(x => x.field),
  ["telefon", "email", "adresse", "oeffnungszeiten"]
);
assert.deepEqual(extractRestaurantData("<html>keine strukturierten Daten</html>"), {});
console.log("Restaurant-Monitor: alle Tests erfolgreich.");
