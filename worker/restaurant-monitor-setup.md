# Restaurant-Webseitenprüfung – Einrichtung

Dieser Stand gehört zum isolierten Entwicklungszweig. Er ist nicht veröffentlicht und verändert keine Live-Daten.

## Tägliche Prüfung

Der Worker verwendet den bereits vorhandenen Cron-Auslöser `0 5 * * *` (UTC). Die erste erfolgreiche Prüfung speichert nur den Ausgangsstand. Erst spätere Abweichungen erzeugen Hinweise.

## E-Mail-Hinweise (optional)

Der E-Mail-Versand ist vorbereitet, aber absichtlich deaktiviert, solange die Zugangsdaten fehlen. Es werden keine Zugangsdaten im Git-Repository gespeichert.

In den Cloudflare-Worker-Einstellungen unter **Settings → Variables and Secrets** müssen bei gewünschtem E-Mail-Versand gesetzt werden:

- `BREVO_API_KEY` – als Secret
- `BREVO_FROM_EMAIL` – verifizierte Absenderadresse
- `BREVO_FROM_NAME` – optionaler Absendername
- `MONITOR_NOTIFICATION_EMAIL` – gewünschte Empfängeradresse

Dazu wird ein Brevo-Konto benötigt. Dort muss die Absenderadresse angelegt und per Bestätigungscode verifiziert werden. Eine kostenlose Maildomain lässt sich nicht per DKIM authentifizieren; Brevo kann in diesem Fall die Absenderadresse ersetzen. Die Zustellbarkeit ist deshalb ohne eigene authentifizierte Domain nicht garantiert. Es ist kein Domainkauf in diesem Code vorausgesetzt.

Wenn die drei Pflichtvariablen fehlen, bleibt die E-Mail-Funktion still deaktiviert. Die Hinweise werden weiterhin in der App gesammelt. Nach erfolgreichem Versand markiert der Worker die betreffenden Hinweise als benachrichtigt.

## Verhalten in der App

- Die Übersicht ist über das App-Menü erreichbar und verlangt das Admin-Passwort.
- Jede Meldung zeigt Restaurant, Feld, bisherigen und gefundenen Wert sowie die offizielle Quellseite.
- „Gesehen – ich kümmere mich“ und „Nicht relevant“ ändern nur den Prüfstatus.
- Restaurantdaten werden niemals automatisch überschrieben.
- Nicht erreichbare Seiten werden als Prüfproblem protokolliert und nicht als Datenänderung ausgegeben.

## Sicherheitsgrenzen

- Es werden nur HTTP(S)-Seiten der gespeicherten offiziellen Website aufgerufen.
- Weiterleitungen auf andere Domains werden blockiert.
- Pro Seite gelten 8 Sekunden Zeitlimit und 1 MB Größenlimit.
- Die Prüfung crawlt die Startseite und höchstens fünf priorisierte Unterseiten je Restaurant.
- PDF-Links auf der offiziellen Domain werden erkannt; die PDF-Dateien selbst werden nicht erneut heruntergeladen. Die bestehende Karten-PDF-Prüfung bleibt separat.
