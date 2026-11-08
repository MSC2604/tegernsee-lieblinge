# Wiederherstellung des App-Symbols

Die unveränderte Sicherung des aktuell verwendeten App-Symbols Nr. 13 liegt in `backup/app-symbol-nr-13.svg`.

## Wiederherstellung

1. Den Inhalt von `backup/app-symbol-nr-13.svg` vollständig kopieren.
2. Damit die Datei `icon-13.svg` im Stammverzeichnis des Projekts ersetzen.
3. Prüfen, dass `index.html` in der Kopfzeile und als Favicon sowie `manifest.webmanifest` weiterhin auf `icon-13.svg` verweisen.
4. Die Änderung ausschließlich auf dem Produktionsbranch `main` veröffentlichen.

Die Sicherung selbst nicht bearbeiten. Frühere Versionen sind zusätzlich über die Git-Dateiversionierung wiederherstellbar.
