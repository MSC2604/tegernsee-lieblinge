import assert from 'node:assert/strict';
import { extractOfficialDocumentLinks, extractOfficialPageLinks, extractPageText, extractRestaurantData, findRestaurantChanges } from './restaurant-monitor.mjs';
const html = '<html><body><script type="application/ld+json">{"@type":"Restaurant","telephone":"+49 8022 12345","email":"info@example.de","address":{"streetAddress":"Seestraße 4","postalCode":"83700","addressLocality":"Tegernsee"},"openingHoursSpecification":[{"dayOfWeek":["Monday"],"opens":"11:00","closes":"22:00"}]}</script><h1>Gasthof am See</h1><p>Ruhetag: Montag</p><p>Betriebsferien: 10. bis 20. Januar</p></body></html>';
const found = extractRestaurantData(html);
assert.equal(found.telefon, '+49 8022 12345');
assert.equal(found.adresse, 'Seestraße 4, 83700 Tegernsee');
assert.equal(found.oeffnungszeiten, 'Monday 11:00–22:00');
assert.equal(found.ruhetag, 'Montag');
assert.equal(found.betriebsferien, '10. bis 20. Januar');
assert.match(extractPageText(html), /Gasthof am See/);
assert.doesNotMatch(extractPageText(html), /application\/ld\+json/);
assert.deepEqual(extractRestaurantData('<html>keine strukturierten Daten</html>'), {});
assert.deepEqual(findRestaurantChanges({ telefon: '08022 99999' }, { telefon: '08022 99999' }), []);
assert.deepEqual(findRestaurantChanges({ telefon: '08022 12345' }, {}), [{ field: 'telefon', oldValue: '08022 12345', newValue: 'Nicht mehr angegeben' }]);

assert.deepEqual(
  extractOfficialPageLinks('<a href="/galerie">Bilder</a><a href="/kontakt">Kontakt</a><a href="/datenschutz">Datenschutz</a><a href="/oeffnungszeiten">Öffnungszeiten</a>', 'https://restaurant.example/'),
  ['https://restaurant.example/kontakt', 'https://restaurant.example/oeffnungszeiten', 'https://restaurant.example/galerie']
);

assert.deepEqual(extractOfficialPageLinks('<a href="/kontakt">Kontakt</a><a href="https://other.example">Extern</a><a href="/karte.pdf">PDF</a>', 'https://restaurant.example/'), ['https://restaurant.example/kontakt']);
assert.deepEqual(extractOfficialDocumentLinks('<a href="/speisekarte.pdf">Speisekarte</a><a href="https://other.example/karte.pdf">Extern</a>', 'https://restaurant.example/'), ['Speisekarte: https://restaurant.example/speisekarte.pdf']);
console.log('Restaurant-Monitor: alle Tests erfolgreich.');
