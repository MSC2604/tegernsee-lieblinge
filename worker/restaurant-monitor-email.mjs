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
  db, env, fetchImpl = fetch, now = () => new Date().toISOString(), summary = {}
}) {
  const notificationEmail = String(env?.MONITOR_NOTIFICATION_EMAIL || "msc4021@arcor.de").trim();
  if (!env?.BREVO_API_KEY || !env?.BREVO_FROM_EMAIL || !notificationEmail) {
    return { sent:false, reason:"Brevo-Versandzugang oder Absenderadresse fehlt." };
  }
  const proposalResult = await db(
    "SELECT p.id, r.name, p.field_name, p.old_value, p.new_value, p.source_url, p.detected_at FROM restaurant_change_proposals p LEFT JOIN restaurants r ON CAST(r.id AS TEXT)=p.restaurant_id WHERE p.status='pending' AND p.notified_at='' ORDER BY p.detected_at DESC, p.id DESC LIMIT 100",
    [], true
  );
  const proposals = (proposalResult?.results?.[0]?.response?.result?.rows || []).map(row => ({
    id:String(cell(row[0])||""), name:String(cell(row[1])||"Restaurant"),
    field:String(cell(row[2])||""), oldValue:String(cell(row[3])||""),
    newValue:String(cell(row[4])||""), sourceUrl:String(cell(row[5])||""),
    detectedAt:String(cell(row[6])||"")
  }));
  const cardResult = await db(
    "SELECT c.restaurant_id, r.name, c.kind, c.url, c.checked_at FROM restaurant_card_checks c LEFT JOIN restaurants r ON CAST(r.id AS TEXT)=c.restaurant_id WHERE c.status='changed' AND c.notified_at='' ORDER BY c.checked_at DESC LIMIT 100",
    [], true
  );
  const cardChanges = (cardResult?.results?.[0]?.response?.result?.rows || []).map(row => ({
    restaurantId:String(cell(row[0])||""), name:String(cell(row[1])||"Restaurant"),
    kind:String(cell(row[2])||""), url:String(cell(row[3])||"")
  }));
  const errors = Array.isArray(summary.errors) ? summary.errors : [];
  const totalChanges = proposals.length + cardChanges.length;
  const fieldNames = {
    telefon:"Telefonnummer", email:"E-Mail-Adresse", website:"Website", adresse:"Adresse",
    oeffnungszeiten:"Öffnungszeiten", ruhetag:"Ruhetag", betriebsferien:"Betriebsferien",
    website_text:"Website-Inhalt", dokumente:"Speisekarten- und PDF-Links",
    unterseiten:"Unterseiten-Links", externe_links:"Reservierungs- und Kontaktlinks"
  };
  const cardName = kind => kind === "speisekarte" ? "Speisekarte" : "Getränkekarte";
  const summaryLines = [
    "Täglicher Restaurant-Prüfbericht","",
    "Offizielle Restaurant-Webseiten geprüft: " + (Number(summary.restaurantsChecked)||0),
    "Externe Eintragsseiten geprüft: " + (Number(summary.externalEntriesChecked)||0),
    "Webseiten und Unterseiten geprüft: " + (Number(summary.pagesChecked)||0),
    "Speise- und Getränkekarten-Links geprüft: " + (Number(summary.cardsChecked)||0),
    "Erkannte Änderungen: " + totalChanges, "Prüfprobleme: " + errors.length, "",
    totalChanges ? "Es wurden Änderungen erkannt. Bitte prüfe die Vorschläge in der App." : "Keine Änderungen festgestellt.",
    "Die Restaurant-Einträge in deiner App wurden NICHT automatisch verändert."
  ];
  const textBody = [
    ...summaryLines,
    ...(proposals.length ? ["","ÄNDERUNGEN AN RESTAURANTDATEN",...proposals.map(item =>
      item.name+" – "+(fieldNames[item.field]||item.field)+"\nBisher: "+(item.oldValue||"Keine Angabe")+
      "\nNeu: "+(item.newValue||"Keine Angabe")+"\nQuelle: "+item.sourceUrl)] : []),
    ...(cardChanges.length ? ["","ÄNDERUNGEN AN SPEISE- UND GETRÄNKEKARTEN",...cardChanges.map(item =>
      item.name+" – "+cardName(item.kind)+"\nQuelle: "+item.url)] : []),
    ...(errors.length ? ["","NICHT ERREICHBARE SEITEN / PRÜFPROBLEME",...errors.map(item =>
      (item.name||"Restaurant")+"\n"+(item.detail||"Prüfung nicht möglich.")+(item.url?"\nQuelle: "+item.url:""))] : []),
    "","Öffne die App und gehe im Menü zu „Änderungen auf Restaurant-Webseiten“."
  ].join("\n");
  const htmlBody = `<h2>Täglicher Restaurant-Prüfbericht</h2>
    <ul>
      <li>Offizielle Restaurant-Webseiten geprüft: ${Number(summary.restaurantsChecked)||0}</li>
      <li>Externe Eintragsseiten geprüft: ${Number(summary.externalEntriesChecked)||0}</li>
      <li>Webseiten und Unterseiten geprüft: ${Number(summary.pagesChecked)||0}</li>
      <li>Speise- und Getränkekarten-Links geprüft: ${Number(summary.cardsChecked)||0}</li>
      <li>Erkannte Änderungen: ${totalChanges}</li><li>Prüfprobleme: ${errors.length}</li>
    </ul>
    <p><strong>${totalChanges?"Änderungen erkannt – bitte in der App prüfen.":"Keine Änderungen festgestellt."}</strong></p>
    <p>Die Restaurant-Einträge in deiner App wurden <strong>nicht automatisch verändert</strong>.</p>
    ${proposals.length?`<h3>Änderungen an Restaurantdaten</h3>${proposals.map(item=>`<section style="margin:16px 0;padding:12px;border:1px solid #dce6df;border-radius:8px">
      <h4>${escapeHtml(item.name)} – ${escapeHtml(fieldNames[item.field]||item.field)}</h4>
      <p><strong>Bisher:</strong><br>${escapeHtml(item.oldValue||"Keine Angabe")}</p>
      <p><strong>Neu:</strong><br>${escapeHtml(item.newValue||"Keine Angabe")}</p>
      <p><a href="${escapeHtml(item.sourceUrl)}">Offizielle Quelle öffnen</a></p></section>`).join("")}`:""}
    ${cardChanges.length?`<h3>Änderungen an Speise- und Getränkekarten</h3><ul>${cardChanges.map(item=>`<li><strong>${escapeHtml(item.name)}</strong> – ${escapeHtml(cardName(item.kind))}: <a href="${escapeHtml(item.url)}">Quelle öffnen</a></li>`).join("")}</ul>`:""}
    ${errors.length?`<h3>Prüfprobleme</h3><ul>${errors.map(item=>`<li><strong>${escapeHtml(item.name||"Restaurant")}</strong>: ${escapeHtml(item.detail||"Prüfung nicht möglich.")} ${item.url?`<a href="${escapeHtml(item.url)}">Quelle</a>`:""}</li>`).join("")}</ul>`:""}
    <p>Öffne die App und gehe im Menü zu „Änderungen auf Restaurant-Webseiten“.</p>`;
  const response = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
    method:"POST",
    headers:{"api-key":env.BREVO_API_KEY,"Content-Type":"application/json","Accept":"application/json"},
    body:JSON.stringify({
      sender:{email:env.BREVO_FROM_EMAIL,name:env.BREVO_FROM_NAME||"Meine Lieblings-Restaurants am Tegernsee"},
      to:[{email:notificationEmail}],
      subject:totalChanges
        ? "Täglicher Restaurant-Prüfbericht – "+totalChanges+" Änderung(en)"
        : errors.length ? "Täglicher Restaurant-Prüfbericht – keine Änderungen, Prüfprobleme"
        : "Täglicher Restaurant-Prüfbericht – keine Änderungen",
      textContent:textBody,htmlContent:htmlBody
    })
  });
  if(!response.ok) throw new Error("Brevo hat den E-Mail-Versand abgelehnt (HTTP "+response.status+"): "+(await response.text()).slice(0,300));
  const stamp=now();
  for(const item of proposals) await db("UPDATE restaurant_change_proposals SET notified_at=? WHERE id=? AND notified_at=''",[arg(stamp),arg(item.id)]);
  for(const item of cardChanges) await db("UPDATE restaurant_card_checks SET notified_at=? WHERE restaurant_id=? AND kind=? AND notified_at=''",[arg(stamp),arg(item.restaurantId),arg(item.kind)]);
  return {sent:true,acceptedByProvider:true,count:totalChanges,proposalCount:proposals.length,cardChangeCount:cardChanges.length,errorCount:errors.length};
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
