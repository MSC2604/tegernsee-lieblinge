# Tägliche Restaurant-Prüfung

Die tägliche Prüfung läuft im produktiven Cloudflare Worker über den Cron-Auslöser `0 5 * * *` (UTC; in Deutschland üblicherweise 06:00 Uhr im Winter und 07:00 Uhr im Sommer).

## Zusammengefasste Prüfung

Ein täglicher Lauf verbindet zwei Prüfbereiche:

- **Speise- und Getränkekarten:** Die in der App hinterlegten Karten-Links werden auf Erreichbarkeit und Inhaltsänderungen geprüft.
- **Restaurant-Webseiten:** Die offiziellen Webseiten und ausgewählte offizielle Unterseiten werden auf erkennbare Änderungen bei Telefonnummer, E-Mail-Adresse, Website, Adresse, Öffnungszeiten, Ruhetag, Betriebsferien, Dokumenten- und relevanten Kontakt-/Reservierungslinks geprüft.

Die E-Mail enthält täglich einen Bericht – auch dann, wenn keine Änderungen erkannt wurden. Sie nennt außerdem die Zahl der geprüften Restaurants, Seiten und Karten-Links sowie nicht erreichbare Seiten und Prüfprobleme. Erkannte Kartenänderungen und Restaurantdatenänderungen werden gemeinsam gemeldet.

## E-Mail-Versand

Der tägliche Bericht wird über Brevo versendet. In den Cloudflare-Worker-Einstellungen unter **Settings → Variables and Secrets** werden benötigt:

- `BREVO_API_KEY` – Secret mit aktivierter Transaktions-E-Mail-Funktion
- `BREVO_FROM_EMAIL` – bei Brevo verifizierte Absenderadresse
- `MONITOR_NOTIFICATION_EMAIL` – Empfängeradresse; wenn nicht gesetzt, wird `msc4021@arcor.de` verwendet
- `BREVO_FROM_NAME` – optionaler Absendername

Der Versand funktioniert erst, wenn Brevo den API-Schlüssel und die Absenderadresse akzeptiert. Ein erfolgreicher Worker-Deploy allein bestätigt noch keine tatsächliche E-Mail-Zustellung.

## Verhalten in der App und Datensicherheit

- Erkannte Änderungen werden als Vorschläge in der App gesammelt.
- Restaurantdaten werden niemals automatisch überschrieben.
- Die E-Mail informiert täglich über Änderungen oder ausdrücklich darüber, dass keine Änderungen festgestellt wurden.
- Nicht erreichbare Seiten werden als Prüfprobleme gemeldet und nicht als Datenänderung ausgegeben.
- Änderungen werden nach erfolgreicher Annahme durch Brevo als benachrichtigt markiert; fehlgeschlagene E-Mail-Versuche lassen offene Hinweise bestehen.

## Grenzen der Prüfung

- Es werden nur HTTP(S)-Seiten der gespeicherten offiziellen Website aufgerufen; lokale und reservierte IP-Adressen werden blockiert.
- Weiterleitungen auf andere Domains werden blockiert.
- Pro Seite gelten Zeit- und Größenlimits.
- Die Prüfung crawlt die Startseite und höchstens fünf priorisierte Unterseiten je Restaurant.
- Reine Design-, CSS-, Bild- oder Layoutänderungen sowie nicht verlinkte Unterseiten werden nicht zuverlässig erkannt.
- PDF-Links auf der offiziellen Domain sowie wichtige externe Reservierungs- und Kontaktlinks werden erkannt; externe Seiten und PDF-Dateien selbst werden nicht erneut heruntergeladen.
