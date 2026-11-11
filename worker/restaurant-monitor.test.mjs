import assert from 'node:assert/strict';
import { extractOfficialDocumentLinks, extractOfficialPageLinks, extractPageText, extractRelevantExternalLinks, extractRestaurantData, findRestaurantChanges } from './restaurant-monitor.mjs';
const html = '<html><body><script type="application/ld+json">{"@type":"Restaurant","telephone":"+49 8022 12345","email":"info@example.de","address":{"streetAddress":"Seestraße 4","postalCode":"83700","addressLocality":"Tegernsee"},"openingHoursSpecification":[{"dayOfWeek":["Monday"],"opens":"11:00","closes":"22:00"}]}</script><h1>Gasthof am See</h1><p>Ruhetag: Montag</p><p>Betriebsferien: 10. bis 20. Januar</p></body></html>';
const found = extractRestaurantData(html);
assert.equal(found.telefon, '+49 8022 12345');
assert.equal(found.adresse, 'Seestraße 4, 83700 Tegernsee');
assert.equal(found.oeffnungszeiten, 'Monday 11:00–22:00');
assert.equal(found.ruhetag, 'Montag');
assert.equal(found.betriebsferien, '10. bis 20. Januar');
assert.match(extractPageText(html), /Gasthof am See/);
assert.doesNotMatch(extractPageText(html), /application\/ld\+json/);
const plainTextData = extractRestaurantData('<p>Öffnungszeiten: Mo 11.30–14.00 und 17.30–22.00 Uhr</p><p>Adresse: Seestraße 8, 83700 Tegernsee</p>');
assert.equal(plainTextData.oeffnungszeiten, 'Mo 11.30–14.00 und 17.30–22.00 Uhr');
assert.equal(plainTextData.adresse, 'Seestraße 8, 83700 Tegernsee');
assert.deepEqual(extractRestaurantData('<html>keine strukturierten Daten</html>'), {});
assert.deepEqual(findRestaurantChanges({ telefon: '08022 99999' }, { telefon: '08022 99999' }), []);
assert.deepEqual(findRestaurantChanges({ telefon: '08022 12345' }, {}), []);
assert.deepEqual(findRestaurantChanges({ telefon: '08022 12345' }, { unterseiten: 'https://shop.example/' }), []);
assert.deepEqual(findRestaurantChanges({ email: 'info@example.de' }, { email: '' }), []);
assert.deepEqual(findRestaurantChanges({ telefon: '08022 12345' }, { telefon: '08022 54321' }), [{ field: 'telefon', oldValue: '08022 12345', newValue: '08022 54321' }]);
assert.deepEqual(extractRestaurantData('<p>shop info@example-shop.de</p>'), {});
assert.equal(extractRestaurantData('<p>E-Mail: info@example.de</p>').email, 'info@example.de');

assert.deepEqual(
  extractOfficialPageLinks('<a href="/galerie">Bilder</a><a href="/kontakt">Kontakt</a><a href="/datenschutz">Datenschutz</a><a href="/oeffnungszeiten">Öffnungszeiten</a>', 'https://restaurant.example/'),
  ['https://restaurant.example/kontakt', 'https://restaurant.example/oeffnungszeiten', 'https://restaurant.example/galerie']
);

assert.deepEqual(extractOfficialPageLinks('<a href="/kontakt">Kontakt</a><a href="https://other.example">Extern</a><a href="/karte.pdf">PDF</a>', 'https://restaurant.example/'), ['https://restaurant.example/kontakt']);
assert.deepEqual(extractOfficialDocumentLinks('<a href="/speisekarte.pdf">Speisekarte</a><a href="https://other.example/karte.pdf">Extern</a>', 'https://restaurant.example/'), ['Speisekarte: https://restaurant.example/speisekarte.pdf']);
assert.deepEqual(extractRelevantExternalLinks('<a href="https://booking.example/table">Tisch reservieren</a><a href="mailto:info@example.de">E-Mail</a><a href="/kontakt">Kontakt</a>', 'https://restaurant.example/'), ['E-Mail: mailto:info@example.de', 'Tisch reservieren: https://booking.example/table']);
console.log('Restaurant-Monitor: alle Tests erfolgreich.');
