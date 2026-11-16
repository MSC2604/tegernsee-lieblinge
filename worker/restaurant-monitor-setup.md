# Tägliche Restaurant-Prüfung

## Zeitplan und Ablauf

Der produktive Cloudflare Worker verwendet UTC-Cron-Auslöser. Die fünf konfigurierten Zeitfenster in `wrangler.toml` decken die 80 Prüfabschnitte von **06:00 bis 07:19 Uhr Europe/Berlin** sowie den separaten Tagesabschluss und die Wiederherstellung fehlender Abschnitte von **07:30 bis 07:59 Uhr Europe/Berlin** ab. Die UTC-Zeitfenster sind so überlappend angelegt, dass sowohl CET (Winterzeit) als auch CEST (Sommerzeit) dieselben lokalen Zeitfenster treffen. Der Worker ordnet jeden Aufruf anhand von `Europe/Berlin` entweder genau einem Prüfabschnitt oder dem Tagesabschluss zu; überzählige UTC-Ausgleichsaufrufe werden protokolliert und übersprungen.

Der Tagesabschluss prüft, ob alle 80 Abschnitte gespeichert wurden. Fehlt ein Abschnitt, wird er kontrolliert nachgeholt. Erst bei vollständiger Prüfung wird der Tagesbericht erstellt und der Versand über Brevo versucht. Die automatische GitHub-Prüfung kontrolliert nach dem Zeitfenster die tatsächlich hinterlegten Cloudflare-Cron-Zeitfenster, die Worker-Telemetrie, die vollständige Zusammenfassung mit 80 Abschnitten und die Bestätigung der Brevo-Annahme.

## Zusammengefasste Prüfung

Ein täglicher Lauf verbindet zwei Prüfbereiche:

- **Speise- und Getränkekarten:** Die in der App hinterlegten Karten-Links werden auf Erreichbarkeit und Inhaltsänderungen geprüft.
- **Restaurant-Webseiten:** Die offiziellen Webseiten und ausgewählte offizielle Unterseiten werden auf erkennbare Änderungen bei Telefonnummer, E-Mail-Adresse, Website, Adresse, Öffnungszeiten, Ruhetag, Betriebsferien, Dokumenten- und relevanten Kontakt-/Reservierungslinks geprüft.

Vor dem Start werden die erforderlichen Brevo-Versandeinstellungen geprüft. Fehlt der API-Schlüssel oder die verifizierte Absenderadresse, wird der Webseitenlauf gar nicht erst gestartet und der Fehler im Worker-Protokoll erfasst. Die E-Mail enthält täglich einen Bericht – auch dann, wenn keine Änderungen erkannt wurden. Sie nennt außerdem die Gesamtzahl der Restaurant-Einträge, wie viele davon eine hinterlegte Website oder externe Eintragsseite haben, die Zahl der tatsächlich geprüften Restaurants, Seiten und Karten-Links sowie nicht erreichbare Seiten und Prüfprobleme. Erkannte Kartenänderungen und Restaurantdatenänderungen werden gemeinsam gemeldet.

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
- Manuelle Prüfberichte verwenden einen eigenen Versand-Schlüssel und blockieren dadurch nicht den automatischen Tagesbericht desselben Tages.
- Die E-Mail informiert täglich über Änderungen oder ausdrücklich darüber, dass keine Änderungen festgestellt wurden.
- Nicht erreichbare Seiten werden als Prüfprobleme gemeldet und nicht als Datenänderung ausgegeben.
- Änderungen werden nach erfolgreicher Annahme durch Brevo als benachrichtigt markiert; fehlgeschlagene E-Mail-Versuche lassen offene Hinweise bestehen.

## Grenzen der Prüfung

- Es werden nur HTTP(S)-Seiten der gespeicherten offiziellen Website aufgerufen; lokale und reservierte IP-Adressen werden blockiert.
- Weiterleitungen auf andere Domains werden blockiert.
- Pro Seite gelten Zeit- und Größenlimits.
- Die Prüfung crawlt die Startseite und höchstens zwei priorisierte Unterseiten je Restaurant.
- Reine Design-, CSS-, Bild- oder Layoutänderungen sowie nicht verlinkte Unterseiten werden nicht zuverlässig erkannt.
- PDF-Links auf der offiziellen Domain sowie wichtige externe Reservierungs- und Kontaktlinks werden erkannt; externe Seiten und PDF-Dateien selbst werden nicht erneut heruntergeladen.
