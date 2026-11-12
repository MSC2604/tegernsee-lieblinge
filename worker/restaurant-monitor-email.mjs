// Optionaler täglicher E-Mail-Sammelhinweis über Brevo.
// Ohne Brevo-API-Schlüssel und verifizierte Absenderadresse wird nichts versendet.
function arg(value) {
  return { type: "text", value: value == null ? "" : String(value) };
}
function cell(value) {
  if (value == null) return "";
  return typeof value === "object" && "value" in value ? value.value : value;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

export async function sendRestaurantWebsiteDigest({
  db,
  env,
  fetchImpl = fetch,
  now = () => new Date().toISOString()
}) {
  const notificationEmail = String(env?.MONITOR_NOTIFICATION_EMAIL || "msc4021@arcor.de").trim();
  if (!env?.BREVO_API_KEY || !env?.BREVO_FROM_EMAIL || !notificationEmail) {
    return { sent: false, reason: "Brevo-Versandzugang oder Absenderadresse fehlt." };
  }
  const result = await db(
    "SELECT p.id, r.name, p.field_name, p.old_value, p.new_value, p.source_url, p.detected_at FROM restaurant_change_proposals p LEFT JOIN restaurants r ON CAST(r.id AS TEXT)=p.restaurant_id WHERE p.status='pending' AND p.notified_at='' ORDER BY p.detected_at DESC, p.id DESC LIMIT 100",
    [], true
  );
  const rows = result?.results?.[0]?.response?.result?.rows || [];
  if (!rows.length) return { sent: false, reason: "Keine neuen Hinweise." };
  const items = rows.map(row => ({
    id: String(cell(row[0]) || ""),
    name: String(cell(row[1]) || "Restaurant"),
    field: String(cell(row[2]) || ""),
    oldValue: String(cell(row[3]) || ""),
    newValue: String(cell(row[4]) || ""),
    sourceUrl: String(cell(row[5]) || ""),
    detectedAt: String(cell(row[6]) || "")
  }));
  const fieldNames = {
    telefon: "Telefonnummer", email: "E-Mail-Adresse", website: "Website",
    adresse: "Adresse", oeffnungszeiten: "Öffnungszeiten", ruhetag: "Ruhetag",
    betriebsferien: "Betriebsferien", website_text: "Website-Inhalt", dokumente: "Speisekarten- und PDF-Links", unterseiten: "Unterseiten-Links", externe_links: "Reservierungs- und Kontaktlinks"
  };
  const textBody = [
    "Auf offiziellen Restaurant-Webseiten wurden neue Änderungen erkannt.",
    "Die Einträge in deiner App wurden NICHT automatisch verändert.",
    "",
    ...items.map(item =>
      item.name + " – " + (fieldNames[item.field] || item.field) +
      "\nBisher: " + (item.oldValue || "Keine Angabe") +
      "\nNeu: " + (item.newValue || "Keine Angabe") +
      "\nQuelle: " + item.sourceUrl
    ),
    "",
    "Öffne die App und gehe im Menü zu „Änderungen auf Restaurant-Webseiten“."
  ].join("\n");
  const htmlBody = `<h2>Neue Änderungen auf Restaurant-Webseiten</h2>
    <p>Die Einträge in deiner App wurden <strong>nicht automatisch verändert</strong>.</p>
    ${items.map(item => `<section style="margin:16px 0;padding:12px;border:1px solid #dce6df;border-radius:8px">
      <h3>${escapeHtml(item.name)} – ${escapeHtml(fieldNames[item.field] || item.field)}</h3>
      <p><strong>Bisher:</strong><br>${escapeHtml(item.oldValue || "Keine Angabe")}</p>
      <p><strong>Neu:</strong><br>${escapeHtml(item.newValue || "Keine Angabe")}</p>
      <p><a href="${escapeHtml(item.sourceUrl)}">Offizielle Quelle öffnen</a></p>
    </section>`).join("")}
    <p>Öffne die App und gehe im Menü zu „Änderungen auf Restaurant-Webseiten“.</p>`;
  const response = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      sender: { email: env.BREVO_FROM_EMAIL, name: env.BREVO_FROM_NAME || "Restaurant-Webseitenprüfung" },
      to: [{ email: notificationEmail }],
      subject: items.length + " neue Änderung(en) auf Restaurant-Webseiten",
      textContent: textBody,
      htmlContent: htmlBody
    })
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error("Brevo hat den E-Mail-Versand abgelehnt (HTTP " + response.status + "): " + detail);
  }
  const stamp = now();
  for (const item of items) {
    await db(
      "UPDATE restaurant_change_proposals SET notified_at=? WHERE id=? AND notified_at=''",
      [arg(stamp), arg(item.id)]
    );
  }
  return { sent: true, acceptedByProvider: true, count: items.length };
}


/**
 * Sendet eine feste Testnachricht an die konfigurierte Benachrichtigungsadresse.
 * Diese Funktion liest oder verändert keinerlei Restaurant- oder Prüfdaten.
 */
export async function sendRestaurantWebsiteTestEmail({
  env,
  fetchImpl = fetch
}) {
  const notificationEmail = String(
    env?.MONITOR_NOTIFICATION_EMAIL || "msc4021@arcor.de"
  ).trim();
  const missingSettings = [];
  if (!String(env?.BREVO_API_KEY || "").trim()) missingSettings.push("BREVO_API_KEY");
  if (!String(env?.BREVO_FROM_EMAIL || "").trim()) missingSettings.push("BREVO_FROM_EMAIL");
  if (!notificationEmail) missingSettings.push("MONITOR_NOTIFICATION_EMAIL");
  if (missingSettings.length) {
    return {
      sent: false,
      reason: "In der Cloudflare-Worker-Umgebung fehlen diese Einstellungen: " + missingSettings.join(", ") + ". Bitte unter Einstellungen > Variablen und Geheimnisse für Produktion prüfen."
    };
  }

  const response = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      sender: {
        email: env.BREVO_FROM_EMAIL,
        name: env.BREVO_FROM_NAME || "Restaurant-Webseitenprüfung"
      },
      to: [{ email: notificationEmail }],
      subject: "Test-E-Mail – Restaurant-Webseitenprüfung",
      textContent: [
        "Dies ist eine Testnachricht deiner Tegernsee-Restaurant-App.",
        "",
        "Der E-Mail-Versand über Brevo wurde vom Dienst angenommen.",
        "Diese Testnachricht hat keine Restaurantdaten, Prüfergebnisse oder Änderungsvorschläge verändert.",
        "",
        "Wenn du diese Nachricht erhältst, funktioniert die Zustellung an dieses Postfach."
      ].join("\n"),
      htmlContent: "<h2>Test-E-Mail erfolgreich angestoßen</h2><p>Der E-Mail-Versand deiner Tegernsee-Restaurant-App wurde von Brevo angenommen.</p><p>Diese Testnachricht hat keine Restaurantdaten, Prüfergebnisse oder Änderungsvorschläge verändert.</p><p>Wenn du diese Nachricht erhältst, funktioniert die Zustellung an dieses Postfach.</p>"
    })
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(
      "Brevo hat den Testversand abgelehnt (HTTP " +
      response.status + "): " + detail
    );
  }

  return {
    sent: true,
    acceptedByProvider: true,
    recipient: notificationEmail
  };
}
