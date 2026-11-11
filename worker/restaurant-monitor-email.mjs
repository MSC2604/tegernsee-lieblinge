// Optionaler täglicher E-Mail-Sammelhinweis über Brevo.
// Ohne die drei Cloudflare-Variablen wird nichts versendet.
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
  if (!env?.BREVO_API_KEY || !env?.BREVO_FROM_EMAIL || !env?.MONITOR_NOTIFICATION_EMAIL) {
    return { sent: false, reason: "E-Mail-Versand noch nicht eingerichtet." };
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
    betriebsferien: "Betriebsferien", website_text: "Website-Inhalt", dokumente: "Speisekarten- und PDF-Links"
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
      to: [{ email: env.MONITOR_NOTIFICATION_EMAIL }],
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
