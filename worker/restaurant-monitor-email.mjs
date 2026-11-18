import { areRestaurantValuesEquivalent } from "./restaurant-monitor.mjs";
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
  // Einen Tagesbericht mit fehlenden oder widersprüchlichen Bestandszahlen
  // niemals versenden. So kann ein alter/falscher Aufrufer nicht erneut
  // „nicht ermittelt“ melden und trotzdem als erfolgreicher Bericht gelten.
  const totalRestaurantEntries = Number(summary.totalRestaurantEntries);
  const restaurantsWithoutWebsiteSource = Number(summary.restaurantsWithoutWebsiteSource);
  if (summary.totalRestaurantEntries == null || summary.restaurantsWithoutWebsiteSource == null ||
      !Number.isSafeInteger(totalRestaurantEntries) || totalRestaurantEntries < 41 ||
      !Number.isSafeInteger(restaurantsWithoutWebsiteSource) || restaurantsWithoutWebsiteSource < 0 ||
      restaurantsWithoutWebsiteSource > totalRestaurantEntries) {
    return {
      sent:false,
      acceptedByProvider:false,
      reason:"Tagesbericht blockiert: Restaurant-Gesamtzahl (mindestens 41) oder Anzahl ohne Website/externen Eintrag fehlt oder ist ungültig. Es wurde keine E-Mail versendet."
    };
  }
  const proposalResult = await db(
    "SELECT p.id, r.name, p.field_name, p.old_value, p.new_value, p.source_url, p.detected_at FROM restaurant_change_proposals p LEFT JOIN restaurants r ON CAST(r.id AS TEXT)=p.restaurant_id WHERE p.status='pending' AND p.notified_at='' AND p.field_name IN ('telefon','email','website','adresse','oeffnungszeiten','ruhetag','betriebsferien','dokumente','externe_links') ORDER BY p.detected_at DESC, p.id DESC LIMIT 100",
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
  const pagesChecked = Number(summary.pagesChecked) || 0;
  const homepageSnapshots = Number(summary.homepageSnapshots) || 0;
  const configuredWebsiteSources = Number(summary.configuredWebsiteSources) ||
    ((Number(summary.restaurantsChecked) || 0) + (Number(summary.externalEntriesChecked) || 0));
  const subpagesChecked = summary.subpagesChecked == null
    ? Math.max(0, pagesChecked - homepageSnapshots)
    : Math.max(0, Number(summary.subpagesChecked) || 0);
  const baselineCoveragePercent = summary.baselineCoveragePercent == null
    ? (configuredWebsiteSources ? Number((homepageSnapshots / configuredWebsiteSources * 100).toFixed(1)) : 100)
    : Math.max(0, Math.min(100, Number(summary.baselineCoveragePercent) || 0));
  // Alte offene Vorschläge können aus früheren Läufen stammen, bevor die
  // Normalisierung aktiv war. Technische Darstellungsunterschiede auch beim
  // Versand ausblenden, ohne die gespeicherten Restaurantdaten anzufassen.
  const meaningfulProposals = proposals.filter(item =>
    !areRestaurantValuesEquivalent(item.field, item.oldValue, item.newValue)
  );
  const totalChanges = meaningfulProposals.length + cardChanges.length;
  const fieldNames = {
    telefon:"Telefonnummer", email:"E-Mail-Adresse", website:"Website", adresse:"Adresse",
    oeffnungszeiten:"Öffnungszeiten", ruhetag:"Ruhetag", betriebsferien:"Betriebsferien",
    website_text:"Website-Inhalt", dokumente:"Speisekarten- und PDF-Links",
    unterseiten:"Unterseiten-Links", externe_links:"Reservierungs- und Kontaktlinks"
  };
  const cardName = kind => kind === "speisekarte" ? "Speisekarte" : "Getränkekarte";
  const summaryLines = [
    "Täglicher Restaurant-Prüfbericht","",
    "Restaurants insgesamt im Datenbestand: " + (summary.totalRestaurantEntries == null ? "nicht ermittelt" : Number(summary.totalRestaurantEntries)),
    "Ohne hinterlegte Website / externen Eintrag: " + (summary.restaurantsWithoutWebsiteSource == null ? "nicht ermittelt" : Number(summary.restaurantsWithoutWebsiteSource)),
    "Offizielle Restaurant-Webseiten geprüft: " + (Number(summary.restaurantsChecked)||0),
    "Externe Eintragsseiten geprüft: " + (Number(summary.externalEntriesChecked)||0),
    "Webseiten und Unterseiten insgesamt geprüft: " + pagesChecked,
    "Darunter Unterseiten geprüft: " + subpagesChecked,
    "Baseline-Abdeckung (Startseiten-Snapshots): " + homepageSnapshots + " von " + configuredWebsiteSources + " Quell-URLs (" + baselineCoveragePercent + " %)",
    "Speise- und Getränkekarten-Links geprüft: " + (summary.cardsChecked == null ? "separate Kartenprüfung" : (Number(summary.cardsChecked)||0)),
    "Erkannte Änderungen: " + totalChanges, "Prüfprobleme: " + errors.length, "",
    totalChanges ? "Es wurden Änderungen erkannt. Bitte prüfe die Vorschläge in der App." : "Keine Änderungen festgestellt.",
    "Die Restaurant-Einträge in deiner App wurden NICHT automatisch verändert."
  ];
  const textBody = [
    ...summaryLines,
    ...(meaningfulProposals.length ? ["","ÄNDERUNGEN AN RESTAURANTDATEN",...meaningfulProposals.map(item =>
      item.name+" – "+(fieldNames[item.field]||item.field)+"\nBisher: "+(item.oldValue||"Keine Angabe")+
      "\nNeu: "+(item.newValue||"Keine Angabe")+"\nQuelle: "+item.sourceUrl)] : []),
    ...(cardChanges.length ? ["",summary.cardsChecked == null ? "ÄNDERUNGEN AN SPEISE- UND GETRÄNKEKARTEN (SEPARATE KARTENPRÜFUNG)" : "ÄNDERUNGEN AN SPEISE- UND GETRÄNKEKARTEN",...cardChanges.map(item =>
      item.name+" – "+cardName(item.kind)+"\nQuelle: "+item.url)] : []),
    ...(errors.length ? ["","NICHT ERREICHBARE SEITEN / PRÜFPROBLEME",...errors.map(item =>
      (item.name||"Restaurant")+"\n"+(item.detail||"Prüfung nicht möglich.")+(item.url?"\nQuelle: "+item.url:""))] : []),
    "","Öffne die App und gehe im Menü zu „Änderungen auf Restaurant-Webseiten“."
  ].join("\n");
  const htmlBody = `<h2>Täglicher Restaurant-Prüfbericht</h2>
    <ul>
      <li>Restaurants insgesamt im Datenbestand: ${summary.totalRestaurantEntries == null ? "nicht ermittelt" : Number(summary.totalRestaurantEntries)}</li>
      <li>Ohne hinterlegte Website / externen Eintrag: ${summary.restaurantsWithoutWebsiteSource == null ? "nicht ermittelt" : Number(summary.restaurantsWithoutWebsiteSource)}</li>
      <li>Offizielle Restaurant-Webseiten geprüft: ${Number(summary.restaurantsChecked)||0}</li>
      <li>Externe Eintragsseiten geprüft: ${Number(summary.externalEntriesChecked)||0}</li>
      <li>Webseiten und Unterseiten insgesamt geprüft: ${pagesChecked}</li>
      <li>Darunter Unterseiten geprüft: ${subpagesChecked}</li>
      <li>Baseline-Abdeckung (Startseiten-Snapshots): ${homepageSnapshots} von ${configuredWebsiteSources} Quell-URLs (${baselineCoveragePercent} %)</li>
      <li>Speise- und Getränkekarten-Links geprüft: ${summary.cardsChecked == null ? "separate Kartenprüfung" : (Number(summary.cardsChecked)||0)}</li>
      <li>Erkannte Änderungen: ${totalChanges}</li><li>Prüfprobleme: ${errors.length}</li>
    </ul>
    <p><strong>${totalChanges?"Änderungen erkannt – bitte in der App prüfen.":"Keine Änderungen festgestellt."}</strong></p>
    <p>Die Restaurant-Einträge in deiner App wurden <strong>nicht automatisch verändert</strong>.</p>
    ${meaningfulProposals.length?`<h3>Änderungen an Restaurantdaten</h3>${meaningfulProposals.map(item=>`<section style="margin:16px 0;padding:12px;border:1px solid #dce6df;border-radius:8px">
      <h4>${escapeHtml(item.name)} – ${escapeHtml(fieldNames[item.field]||item.field)}</h4>
      <p><strong>Bisher:</strong><br>${escapeHtml(item.oldValue||"Keine Angabe")}</p>
      <p><strong>Neu:</strong><br>${escapeHtml(item.newValue||"Keine Angabe")}</p>
      <p><a href="${escapeHtml(item.sourceUrl)}">Offizielle Quelle öffnen</a></p></section>`).join("")}`:""}
    ${cardChanges.length?`<h3>Änderungen an Speise- und Getränkekarten${summary.cardsChecked == null ? " (separate Kartenprüfung)" : ""}</h3><ul>${cardChanges.map(item=>`<li><strong>${escapeHtml(item.name)}</strong> – ${escapeHtml(cardName(item.kind))}: <a href="${escapeHtml(item.url)}">Quelle öffnen</a></li>`).join("")}</ul>`:""}
    ${errors.length?`<h3>Prüfprobleme</h3><ul>${errors.map(item=>`<li><strong>${escapeHtml(item.name||"Restaurant")}</strong>: ${escapeHtml(item.detail||"Prüfung nicht möglich.")} ${item.url?`<a href="${escapeHtml(item.url)}">Quelle</a>`:""}</li>`).join("")}</ul>`:""}
    <p>Öffne die App und gehe im Menü zu „Änderungen auf Restaurant-Webseiten“.</p>`;
  // Ein Bericht pro Berliner Kalendertag: Die INSERT-RETURNING-Operation ist atomar.
  // Ein bestehender Status "sending"/"unknown" wird bewusst nicht erneut versendet,
  // weil Brevo die erste Nachricht trotz Verbindungsfehler angenommen haben könnte.
  const runDate = String(summary.runDate || new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(now())));
  await db(`CREATE TABLE IF NOT EXISTS restaurant_monitor_email_runs (
    run_date TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    claimed_at TEXT NOT NULL DEFAULT '',
    sent_at TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT ''
  )`);
  const claim = await db(
    "INSERT INTO restaurant_monitor_email_runs (run_date, status, claimed_at) VALUES (?, 'sending', ?) ON CONFLICT(run_date) DO NOTHING RETURNING run_date",
    [arg(runDate), arg(now())], true
  );
  let claimedRows = claim?.results?.[0]?.response?.result?.rows || [];
  if (!claimedRows.length) {
    const state = await db("SELECT status FROM restaurant_monitor_email_runs WHERE run_date=?", [arg(runDate)], true);
    const existingStatus = String(cell(state?.results?.[0]?.response?.result?.rows?.[0]?.[0]) || "unknown");
    if (existingStatus === "sent") {
      return {sent:true,acceptedByProvider:true,duplicateSuppressed:true,runDate,count:totalChanges};
    }
    // Ein explizites HTTP 429 ist eine eindeutige Ablehnung. Ein späterer
    // Finalizer darf genau einen neuen, atomar beanspruchten Versuch starten.
    if (existingStatus === "retryable") {
      const retryClaim = await db(
        "UPDATE restaurant_monitor_email_runs SET status='sending', claimed_at=?, detail='' WHERE run_date=? AND status='retryable' RETURNING run_date",
        [arg(now()), arg(runDate)], true
      );
      claimedRows = retryClaim?.results?.[0]?.response?.result?.rows || [];
    }
    if (!claimedRows.length) {
      return {sent:false,acceptedByProvider:false,duplicateSuppressed:true,runDate,reason:"Für heute existiert bereits ein Versandversuch mit Status '" + existingStatus + "'. Zur Vermeidung doppelter E-Mails wird nicht erneut gesendet."};
    }
  }

  const payload = {
    sender:{email:env.BREVO_FROM_EMAIL,name:env.BREVO_FROM_NAME||"Meine Lieblings-Restaurants am Tegernsee"},
    to:[{email:notificationEmail}],
    subject:totalChanges
      ? "Täglicher Restaurant-Prüfbericht – "+totalChanges+" Änderung(en)"
      : errors.length ? "Täglicher Restaurant-Prüfbericht – keine Änderungen, Prüfprobleme"
      : "Täglicher Restaurant-Prüfbericht – keine Änderungen",
    textContent:textBody,htmlContent:htmlBody
  };
  let response, responseText = "";
  // Nur HTTP 429 ist eine eindeutige Rate-Limit-Ablehnung und wird erneut versucht.
  // HTTP 408 und 5xx können trotz Fehlerantwort bereits verarbeitet worden sein:
  // keine automatische Wiederholung, um doppelte Tagesberichte zu vermeiden.
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      response = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
        method:"POST",
        headers:{"api-key":env.BREVO_API_KEY,"Content-Type":"application/json","Accept":"application/json"},
        body:JSON.stringify(payload)
      });
      if (response.ok) break;
      responseText = (await response.text()).slice(0,300);
      const retryable = response.status === 429;
      if (!retryable || attempt === 3) {
        throw new Error("Brevo hat den E-Mail-Versand abgelehnt (HTTP "+response.status+"): "+responseText);
      }
      await new Promise(resolve => setTimeout(resolve, attempt * 750));
    }
    if (!response?.ok) {
      throw new Error("Brevo hat den E-Mail-Versand nach drei Versuchen nicht bestätigt: "+responseText);
    }
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    // Nur ein explizites HTTP 429 ist sicher abgelehnt und darf beim nächsten
    // Finalizer erneut versucht werden. Netzwerkfehler/408/5xx bleiben unknown.
    const nextStatus = /HTTP 429\b/.test(message) ? "retryable" : "unknown";
    await db(
      "UPDATE restaurant_monitor_email_runs SET status=?, detail=? WHERE run_date=? AND status='sending'",
      [arg(nextStatus), arg(message), arg(runDate)]
    );
    throw error;
  }
  const stamp=now();
  // Erst die angenommene Nachricht dauerhaft als versendet markieren, danach
  // Benachrichtigungskennzeichen aktualisieren. So kann ein DB-Fehler danach
  // beim nächsten Lauf keine zweite Tagesmail auslösen.
  await db(
    "UPDATE restaurant_monitor_email_runs SET status='sent', sent_at=?, detail='' WHERE run_date=? AND status='sending'",
    [arg(stamp), arg(runDate)]
  );
  const notificationUpdates = [
    ...meaningfulProposals.map(item => ({ sql: "UPDATE restaurant_change_proposals SET notified_at=? WHERE id=? AND notified_at=''", args: [arg(stamp), arg(item.id)] })),
    ...cardChanges.map(item => ({ sql: "UPDATE restaurant_card_checks SET notified_at=? WHERE restaurant_id=? AND kind=? AND notified_at=''", args: [arg(stamp), arg(item.restaurantId), arg(item.kind)] }))
  ];
  if (notificationUpdates.length && typeof db.batch === "function") {
    await db.batch(notificationUpdates);
  } else {
    for (const item of notificationUpdates) await db(item.sql, item.args);
  }
  return {sent:true,acceptedByProvider:true,recipient:notificationEmail,runDate,count:totalChanges,proposalCount:meaningfulProposals.length,cardChangeCount:cardChanges.length,ignoredTechnicalProposalCount:proposals.length-meaningfulProposals.length,errorCount:errors.length};
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
