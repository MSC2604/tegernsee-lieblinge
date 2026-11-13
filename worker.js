import { sendRestaurantWebsiteDigest, sendRestaurantWebsiteTestEmail } from "./worker/restaurant-monitor-email.mjs";
import { runRestaurantWebsiteMonitor } from "./worker/restaurant-monitor-runner.mjs";

async function runScheduledRestaurantMonitoring(env, ctx) {
    if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
      throw new Error("Turso-Konfiguration fehlt; der Restaurant-Prüflauf konnte nicht ausgeführt werden.");
    }
    const dbUrl = env.TURSO_DATABASE_URL.replace(/^libsql:\/\//, "https://") + "/v3/pipeline";
    async function db(sql, args = [], wantRows = false) {
      const response = await fetch(dbUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURSO_AUTH_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ baton: null, requests: [
          { type: "execute", stmt: { sql, args, want_rows: wantRows } },
          { type: "close" }
        ] })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Turso HTTP ${response.status}`);
      const first = data?.results?.[0];
      if (first?.type === "error" || first?.error || first?.response?.error) {
        throw new Error(first.error?.message || first.response?.error?.message || "Turso-Abfrage fehlgeschlagen");
      }
      return data;
    }
    const arg = value => ({ type: "text", value: value == null ? "" : String(value) });
    const cell = value => value == null ? "" : (typeof value === "object" && "value" in value ? value.value : value);
    await db(`CREATE TABLE IF NOT EXISTS restaurant_card_checks (
      restaurant_id TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL,
      checked_at TEXT NOT NULL DEFAULT '', changed_at TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '', notified_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (restaurant_id, kind)
    )`);
    // Bestehende Tabellen aus älteren Läufen nachziehen: Der Upsert unten
    // verwendet notified_at auch dann, wenn die Tabelle bereits existiert.
    const cardCheckColumns = await db("PRAGMA table_info(restaurant_card_checks)", [], true);
    const cardCheckColumnNames = new Set(
      (cardCheckColumns?.results?.[0]?.response?.result?.rows || [])
        .map(row => String(cell(row[1]) || ""))
    );
    if (!cardCheckColumnNames.has("notified_at")) {
      await db("ALTER TABLE restaurant_card_checks ADD COLUMN notified_at TEXT NOT NULL DEFAULT ''");
    }
    const query = await db(
      "SELECT restaurant_id, kind, url FROM restaurant_cards WHERE url <> '' AND kind IN ('speisekarte','getraenkekarte')",
      [], true
    );
    const rows = query?.results?.[0]?.response?.result?.rows || [];
    const entries = rows.map(row => ({ restaurantId: String(cell(row[0]) || ""), kind: String(cell(row[1]) || ""), url: String(cell(row[2]) || "") }))
      .filter(x => x.restaurantId && x.url);

    function safeUrl(raw) {
      let u;
      try { u = new URL(raw); } catch { return null; }
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return null;
      const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") ||
          /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === "::1" || h.startsWith("fc") ||
          h.startsWith("fd") || h.startsWith("fe80:") || h === "169.254.169.254") return null;
      return u;
    }

    async function check(item) {
      const now = new Date().toISOString();
      let status = "ok", detail = "", hash = "";
      try {
        let current = item.url, response;
        for (let hop = 0; hop <= 3; hop++) {
          const parsed = safeUrl(current);
          if (!parsed) throw new Error("URL aus Sicherheitsgründen nicht geprüft.");
          const abort = new AbortController();
          const timer = setTimeout(() => abort.abort(), 8000);
          try {
            response = await fetch(parsed.href, {
              redirect: "manual", signal: abort.signal,
              headers: { "User-Agent": "TegernseeRestaurantMenuChecker/1.0", "Accept": "text/html,application/pdf,*/*;q=0.5" }
            });
          } finally { clearTimeout(timer); }
          if ([301,302,303,307,308].includes(response.status)) {
            const loc = response.headers.get("Location");
            if (!loc || hop === 3) throw new Error("Weiterleitung nicht auflösbar.");
            current = new URL(loc, parsed.href).href;
            continue;
          }
          break;
        }
        if (!response?.ok) {
          status = "unreachable";
          detail = response ? `HTTP ${response.status}` : "Keine Antwort";
        } else {
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Antwortinhalt nicht lesbar.");
          const chunks = []; let total = 0, tooLarge = false;
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > 1048576) { tooLarge = true; await reader.cancel(); break; }
            chunks.push(part.value);
          }
          if (tooLarge) {
            status = "too_large"; detail = "Quelle über 1 MB; Inhaltsvergleich übersprungen.";
          } else {
            const bytes = new Uint8Array(total); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            const digest = await crypto.subtle.digest("SHA-256", bytes);
            hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
            detail = "Quelle erreichbar; Inhalt geprüft.";
          }
        }
      } catch (error) {
        status = "error";
        detail = error?.name === "AbortError" ? "Zeitüberschreitung." : String(error?.message || error).slice(0, 220);
      }

      const oldResult = await db(
        "SELECT url, content_hash, changed_at FROM restaurant_card_checks WHERE restaurant_id = ? AND kind = ?",
        [arg(item.restaurantId), arg(item.kind)], true
      );
      const old = oldResult?.results?.[0]?.response?.result?.rows?.[0];
      const oldUrl = old ? String(cell(old[0]) || "") : "";
      const oldHash = old ? String(cell(old[1]) || "") : "";
      const oldChanged = old ? String(cell(old[2]) || "") : "";
      const changedAt = hash && oldUrl === item.url && oldHash && oldHash !== hash ? now :
        (oldUrl === item.url ? oldChanged : (hash ? now : ""));
      if (hash && oldUrl === item.url && oldHash && oldHash !== hash) status = "changed";
      if (hash && oldUrl === item.url && oldHash === hash) status = "unchanged";
      if (hash && (!oldHash || oldUrl !== item.url)) status = "baseline";
      await db(`INSERT INTO restaurant_card_checks
        (restaurant_id, kind, url, checked_at, changed_at, content_hash, status, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(restaurant_id, kind) DO UPDATE SET
          url=excluded.url, checked_at=excluded.checked_at, changed_at=excluded.changed_at,
          content_hash=CASE WHEN excluded.content_hash <> '' THEN excluded.content_hash
            WHEN restaurant_card_checks.url = excluded.url THEN restaurant_card_checks.content_hash ELSE '' END,
          status=CASE WHEN restaurant_card_checks.status='changed' AND restaurant_card_checks.notified_at='' AND excluded.status='unchanged' THEN 'changed' ELSE excluded.status END,
          detail=excluded.detail,
          notified_at=CASE WHEN excluded.status='changed' THEN '' ELSE restaurant_card_checks.notified_at END`,
        [arg(item.restaurantId), arg(item.kind), arg(item.url), arg(now), arg(changedAt), arg(hash), arg(status), arg(detail)]
      );
    }
    const cardRunStartedAt = new Date().toISOString();
    for (let i = 0; i < entries.length; i += 5) {
      await Promise.all(entries.slice(i, i + 5).map(check));
    }
    console.log(`Kartenprüfung abgeschlossen: ${entries.length} offizielle Kartenlinks geprüft.`);
    const cardIssueResult = await db(
      "SELECT r.name, c.kind, c.url, c.status, c.detail FROM restaurant_card_checks c LEFT JOIN restaurants r ON CAST(r.id AS TEXT)=c.restaurant_id WHERE c.checked_at >= ? AND c.status IN ('unreachable','error','too_large') ORDER BY r.name, c.kind",
      [arg(cardRunStartedAt)], true
    );
    const cardIssues = (cardIssueResult?.results?.[0]?.response?.result?.rows || []).map(row => ({
      name: String(cell(row[0]) || "Restaurant"), kind: String(cell(row[1]) || ""),
      url: String(cell(row[2]) || ""), status: String(cell(row[3]) || ""),
      detail: String(cell(row[4]) || "")
    }));

    await db(`CREATE TABLE IF NOT EXISTS restaurant_site_snapshots (
      restaurant_id TEXT NOT NULL, page_url TEXT NOT NULL, checked_at TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '', extracted_data_json TEXT NOT NULL DEFAULT '{}',
      content_text TEXT NOT NULL DEFAULT '', PRIMARY KEY (restaurant_id, page_url)
    )`);
    await db(`CREATE TABLE IF NOT EXISTS restaurant_change_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, restaurant_id TEXT NOT NULL, field_name TEXT NOT NULL,
      old_value TEXT NOT NULL DEFAULT '', new_value TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL,
      detected_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected')), reviewed_at TEXT NOT NULL DEFAULT '',
    notified_at TEXT NOT NULL DEFAULT '',
      UNIQUE (restaurant_id, field_name, old_value, new_value)
    )`);
    await db("CREATE INDEX IF NOT EXISTS idx_restaurant_change_proposals_status ON restaurant_change_proposals(status, detected_at)");
    const restaurantResult = await db(
      "SELECT id, name, website, externer_eintrag FROM restaurants WHERE (website IS NOT NULL AND TRIM(website) <> '') OR (externer_eintrag IS NOT NULL AND TRIM(externer_eintrag) <> '')",
      [], true
    );
    const restaurantRows = restaurantResult?.results?.[0]?.response?.result?.rows || [];
    const allSources = restaurantRows.map(row => ({
      id:String(cell(row[0]) || ""), name:String(cell(row[1]) || ""),
      website:String(cell(row[2]) || ""), externer_eintrag:String(cell(row[3]) || "")
    })).filter(item => item.id);
    const websiteSources = [
      ...allSources.filter(item => item.website).map(item => ({ id:item.id, name:item.name, website:item.website, sourceType:"official" })),
      ...allSources.filter(item => item.externer_eintrag).map(item => ({ id:item.id, name:item.name, website:item.externer_eintrag, sourceType:"external" }))
    ];
    const monitorReport = await runRestaurantWebsiteMonitor({ db, restaurants: websiteSources });
    console.log("Website-Prüfung:", JSON.stringify({
      restaurants:monitorReport.restaurants, externalEntries:monitorReport.externalEntries,
      pages:monitorReport.pages, baselines:monitorReport.baselines,
      proposals:monitorReport.proposals, errors:monitorReport.errors.length
    }));
    for (const issue of monitorReport.errors.slice(0, 30)) {
      console.warn("Website-Prüfung nicht möglich:", JSON.stringify(issue));
    }
    const dailyErrors = [
      ...monitorReport.errors.map(issue => ({ name: issue.name || "Restaurant", url: issue.url || "", detail: issue.error || "Website-Prüfung fehlgeschlagen." })),
      ...cardIssues.map(issue => ({
        name: issue.name, url: issue.url,
        detail: (issue.kind === "speisekarte" ? "Speisekarte" : "Getränkekarte") + ": " + issue.detail
      }))
    ];
    let emailReport;
    try {
      emailReport = await sendRestaurantWebsiteDigest({
        db, env,
        summary: {
          restaurantsChecked: monitorReport.restaurants,
          externalEntriesChecked: monitorReport.externalEntries,
          pagesChecked: monitorReport.pages,
          cardsChecked: entries.length,
          errors: dailyErrors
        }
      });
      console.log("Restaurant-Prüfbericht:", JSON.stringify(emailReport));
    } catch (error) {
      emailReport = { sent: false, reason: String(error?.message || error).slice(0, 500) };
      console.error("Restaurant-Prüfbericht fehlgeschlagen:", emailReport.reason);
    }
    return {
      completed: true,
      summary: {
        restaurantsChecked: monitorReport.restaurants,
        externalEntriesChecked: monitorReport.externalEntries,
        pagesChecked: monitorReport.pages,
        cardsChecked: entries.length,
        changes: monitorReport.proposals,
        errors: dailyErrors.length
      },
      email: emailReport
    };
  }

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    };

    function json(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        }
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (
      !env.TURSO_DATABASE_URL ||
      !env.TURSO_AUTH_TOKEN ||
      !env.ADMIN_PASSWORD
    ) {
      return json({ error: "Serverkonfiguration unvollständig" }, 500);
    }

    const dbUrl =
      env.TURSO_DATABASE_URL.replace(/^libsql:\/\//, "https://") +
      "/v3/pipeline";

    async function turso(sql, args = [], wantRows = false) {
      const response = await fetch(dbUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TURSO_AUTH_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          baton: null,
          requests: [
            {
              type: "execute",
              stmt: { sql, args, want_rows: wantRows }
            },
            { type: "close" }
          ]
        })
      });

      const responseText = await response.text();
      let data;
      try { data = JSON.parse(responseText); }
      catch { data = null; }

      if (!response.ok) {
        const detail = String(data?.error || data?.message || responseText || "").slice(0, 240);
        throw new Error(`Turso HTTP-Fehler (${response.status})${detail ? ": " + detail : ""}`);
      }
      if (!data) throw new Error("Turso hat keine gültige JSON-Antwort geliefert.");

      const first = data?.results?.[0];

      if (first?.type === "error" || first?.error || first?.response?.error) {
        throw new Error(
          first.error?.message ||
          first.response?.error?.message ||
          "Datenbankabfrage fehlgeschlagen"
        );
      }

      return data;
    }

    // Mehrere Monitor-Schreibvorgänge in EINER Turso-Pipeline ausführen.
    // Das spart Cloudflare-Worker-Subrequests, ohne Restaurantdaten anzufassen.
    turso.batch = async function batch(statements) {
      const items = Array.isArray(statements) ? statements.filter(item => item && item.sql) : [];
      if (!items.length) return { results: [] };
      const response = await fetch(dbUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TURSO_AUTH_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          baton: null,
          requests: [
            ...items.map(item => ({
              type: "execute",
              stmt: { sql: item.sql, args: item.args || [], want_rows: false }
            })),
            { type: "close" }
          ]
        })
      });
      const responseText = await response.text();
      let data;
      try { data = JSON.parse(responseText); } catch { data = null; }
      if (!response.ok) {
        const detail = String(data?.error || data?.message || responseText || "").slice(0, 240);
        throw new Error(`Turso-Batch HTTP-Fehler (${response.status})${detail ? ": " + detail : ""}`);
      }
      if (!data) throw new Error("Turso-Batch lieferte keine gültige JSON-Antwort.");
      for (const result of data.results || []) {
        if (result?.type === "error" || result?.error || result?.response?.error) {
          throw new Error(result.error?.message || result.response?.error?.message || "Datenbank-Batch fehlgeschlagen");
        }
      }
      return data;
    };

    function textArg(value) {
      return { type: "text", value: value == null ? "" : String(value) };
    }

    function integerArg(value) {
      return { type: "integer", value: String(value) };
    }

    function rowValue(value) {
      // LibSQL/Turso kann Werte je nach Antwortpfad mehrfach als {value: ...} verpacken.
      // Alle Wrapper entfernen, damit Dateinamen nicht als "[object Object]" erscheinen
      // und die PDF-Prüfung echte Zeichenketten und Zahlen vergleicht.
      let current = value;
      for (let depth = 0; depth < 8; depth++) {
        if (current == null) return "";
        if (typeof current === "object" && !Array.isArray(current) && "value" in current) {
          current = current.value;
          continue;
        }
        return current;
      }
      return current;
    }

    function isAdmin(req) {
      const auth = req.headers.get("Authorization") || "";
      return auth.startsWith("Bearer ") &&
        auth.substring(7) === env.ADMIN_PASSWORD;
    }

    // --------------------------------------------------
    // TAVILY: VERBRAUCH UND GUTHABEN
    // --------------------------------------------------

    
async function getTavilyUsage() {
  if (!env.TAVILY_API_KEY) {
    throw new Error("TAVILY_API_KEY ist nicht eingerichtet.");
  }

  const response = await fetch("https://api.tavily.com/usage", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.TAVILY_API_KEY}`
    },
    cache: "no-store"
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Tavily Usage HTTP-Fehler (${response.status}).`
    );
  }

  const key = data.key || {};
const account = data.account || {};

console.log("Tavily usage account:", {
  plan_usage: account.plan_usage,
  plan_limit: account.plan_limit
});

  // Gesamtverbrauch des Kontos bevorzugen.
  const accountUsed = account.plan_usage;
  const keyUsed = key.usage;

  const used =
    accountUsed != null && Number.isFinite(Number(accountUsed))
      ? Number(accountUsed)
      : keyUsed != null && Number.isFinite(Number(keyUsed))
        ? Number(keyUsed)
        : null;

  // Kontolimit bevorzugen, ansonsten das Schlüssellimit.
  const accountLimit = account.plan_limit;
  const keyLimit = key.limit;

  const limit =
    accountLimit != null && Number.isFinite(Number(accountLimit))
      ? Number(accountLimit)
      : keyLimit != null && Number.isFinite(Number(keyLimit))
        ? Number(keyLimit)
        : null;

  const available = used !== null && limit !== null;

  return {
    available,
    plan: account.current_plan || "Laut Tavily-Konto",
    used,
    limit,
    remaining: available
      ? Math.max(0, limit - used)
      : null,
    searchUsage: key.search_usage ?? null,
    extractUsage: key.extract_usage ?? null,
    crawlUsage: key.crawl_usage ?? null,
    mapUsage: key.map_usage ?? null,
    note: !available
      ? "Tavily hat keine auswertbaren Verbrauchswerte geliefert."
      : "Verbrauch und Limit stammen bevorzugt aus dem Tavily-Konto."
  };
}
    // --------------------------------------------------
    // RESTAURANTSUCHE
    // Quellenübergabe für die Prüfübersicht: Diese Version muss im Worker aktiv sein.
    // Keine Datenbankänderungen während der Recherche.
    // --------------------------------------------------

    async function lookupRestaurant(name) {
      if (!env.TAVILY_API_KEY) {
        throw new Error("TAVILY_API_KEY ist nicht eingerichtet.");
      }

      const cleanName = String(name || "").trim().slice(0, 120);

      if (cleanName.length < 2) {
        throw new Error("Bitte einen gültigen Restaurantnamen eingeben.");
      }

      // Ortszusätze aus dem Suchbegriff entfernen, damit Varianten wie
      // "Postillion", "Postillion Rottach-Egern" und "Postillion am Tegernsee"
      // denselben stabilen Kernnamen verwenden. Die Region wird separat ergänzt.
      const searchName = cleanName
        .replace(/^\s*(?:restaurant|gasthof|wirtshaus)\s+/i, "")
        .replace(/\s*[,–—-]?\s*(?:am\s+)?(?:rottach[\s-]?egern|bad\s+wiessee|schliersee|kreuth|gmund(?:\s+am\s+tegernsee)?|tegernsee)\s*$/i, "")
        .trim() || cleanName;

      const tavilyHeaders = {
        Authorization: `Bearer ${env.TAVILY_API_KEY}`,
        "Content-Type": "application/json"
      };

      // 1. Kostengünstige Basissuche. Der Suchkern ist unabhängig davon,
      // ob der Nutzer den Ort an den Namen angehängt hat.
      const searchResponse = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: tavilyHeaders,
        body: JSON.stringify({
          query:
            `"${searchName}" (Kreuth OR Tegernsee OR Gmund OR Rottach-Egern OR "Bad Wiessee" OR Schliersee) Restaurant Adresse Telefon E-Mail ` +
            "offizielle Website Öffnungszeiten Küchenzeiten Ruhetag Speisekarte Getränkekarte Reservierung Tisch reservieren",
          topic: "general",
          search_depth: "basic",
          max_results: 10,
          country: "germany",
          include_answer: false,
          include_raw_content: false
        })
      });

      if (!searchResponse.ok) {
        throw new Error(
          `Tavily-Suche fehlgeschlagen (HTTP ${searchResponse.status}).`
        );
      }

      const searchData = await searchResponse.json();
      let results = Array.isArray(searchData.results)
        ? searchData.results
        : [];

      // Zusätzliche gezielte Suche nach Karten- und Reservierungsseiten.
      // Ein Fehler hier darf die normale Restaurantsuche nicht abbrechen.
      try {
        const specialResponse = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: tavilyHeaders,
          body: JSON.stringify({
            query: `"${searchName}" (Kreuth OR Tegernsee OR Gmund OR Rottach-Egern OR "Bad Wiessee" OR Schliersee) offizielle Speisekarte Getränkekarte online Tischreservierung reservieren`,
            topic: "general",
            search_depth: "basic",
            max_results: 8,
            country: "germany",
            include_answer: false,
            include_raw_content: false
          })
        });
        if (specialResponse.ok) {
          const specialData = await specialResponse.json();
          const specialResults = Array.isArray(specialData.results) ? specialData.results : [];
          const seenUrls = new Set(results.map(item => String(item.url || "")));
          for (const item of specialResults) {
            const itemUrl = String(item.url || "");
            if (itemUrl && !seenUrls.has(itemUrl)) {
              results.push(item);
              seenUrls.add(itemUrl);
            }
          }
        }
      } catch (error) {
        console.log("Gezielte Karten-/Reservierungssuche übersprungen:", String(error));
      }

      // Separate gezielte Suche nach tatsächlichen Wochenöffnungszeiten.
      // Sie sucht ausdrücklich nach einzelnen Wochentagen, nicht nur "täglich ab".
      try {
        const hoursResponse = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: tavilyHeaders,
          body: JSON.stringify({
            query: `"${searchName}" (Kreuth OR Tegernsee OR Gmund OR Rottach-Egern OR "Bad Wiessee" OR Schliersee) Öffnungszeiten Montag Dienstag Mittwoch Donnerstag Freitag Samstag Sonntag Ruhetag`,
            topic: "general",
            search_depth: "basic",
            max_results: 6,
            country: "germany",
            include_answer: false,
            include_raw_content: false
          })
        });
        if (hoursResponse.ok) {
          const hoursData = await hoursResponse.json();
          const hoursResults = Array.isArray(hoursData.results) ? hoursData.results : [];
          const seenUrls = new Set(results.map(item => String(item.url || "")));
          for (const item of hoursResults) {
            const itemUrl = String(item.url || "");
            if (itemUrl && !seenUrls.has(itemUrl)) {
              results.push(item);
              seenUrls.add(itemUrl);
            }
          }
        }
      } catch (error) {
        console.log("Gezielte Öffnungszeiten-Suche übersprungen:", String(error));
      }

      function normalize(value) {
        return String(value || "")
          .toLocaleLowerCase("de")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
      }

      const normalizedName = normalize(searchName);
      const localNameTokens = new Set([
        "tegernsee", "gmund", "rottach", "egern", "bad", "wiessee",
        "schliersee", "kreuth", "enterbach", "weissach", "waakirchen",
        "hausham", "bayrischzell"
      ]);
      const nameTokens = normalizedName
        .split(/\s+/)
        .filter(token =>
          token.length > 2 &&
          !localNameTokens.has(token) &&
          ![
            "der", "die", "das", "zum", "zur", "am", "im", "bei",
            "restaurant", "gasthof", "wirtshaus", "cafe", "café"
          ].includes(token)
        );

      function isDirectory(url) {
        try {
          const host = new URL(url).hostname.toLowerCase();
          const domains = [
            "google.", "facebook.com", "instagram.com",
            "tripadvisor.", "yelp.", "restaurantguru.",
            "speisekarte.menu", "speisekarte.de", "11880.com",
            "gelbeseiten.de", "openstreetmap.org", "wikipedia.org",
            "tiktok.com", "booking.com", "thefork.",
            "tegernsee.com", "bayregio.de"
          ];

          return domains.some(domain =>
            host === domain ||
            host.endsWith("." + domain) ||
            host.includes(domain)
          );
        } catch {
          return true;
        }
      }

      // Treffer müssen sowohl zum Namen als auch zur Region Tegernsee passen.
      // Ein Namensähnlichkeitstreffer wie "Hagn's" in Hagen reicht allein nicht.
      const localPlaces = [
        "tegernsee", "gmund", "rottach egern", "kreuth",
        "bad wiessee", "schliersee", "enterbach", "weissach",
        "waakirchen", "hausham", "bayrischzell"
      ];
      function hasLocalEvidence(result) {
        const haystack = normalize([
          result.title || "",
          result.content || "",
          result.url || ""
        ].join(" "));
        const postalCode = /\b(?:83700|83703|83707|83708|83727|83730|83734|83684)\b/.test(
          String([result.title || "", result.content || "", result.url || ""].join(" "))
        );
        return postalCode || localPlaces.some(place => haystack.includes(place));
      }

      function hasStrongNameMatch(result) {
        const title = normalize(result.title);
        let host = "";
        try { host = normalize(new URL(result.url).hostname.replace(/^www\./i, "")); } catch {}
        // Markante Namensbestandteile müssen im Titel oder in der Domain stehen,
        // nicht nur irgendwo im allgemeinen Suchtext.
        return nameTokens.some(token =>
          title.split(/\s+/).includes(token) ||
          host.split(/\s+/).some(part => part === token || part.startsWith(token))
        );
      }

      const relevant = results.filter(result =>
        hasStrongNameMatch(result) && hasLocalEvidence(result)
      );

      if (!relevant.length) return [];

      // Eigene Restaurant-Webseiten bevorzugen.
      relevant.sort((a, b) => {
        function score(result) {
          if (!result.url || isDirectory(result.url)) return 0;

          let value = 1;
          try {
            const host = new URL(result.url).hostname.toLowerCase();
            if (nameTokens.some(token => host.includes(token))) value += 10;
          } catch {
            return 0;
          }

          const title = normalize(result.title);
          if (nameTokens.some(token => title.includes(token))) value += 2;
          return value;
        }

        return score(b) - score(a);
      });

      // Nur bis zu fünf unterschiedliche, gültige HTTP(S)-URLs auslesen.
      const urls = [];
      for (const result of relevant) {
        try {
          const parsed = new URL(result.url);
          if (
            !["http:", "https:"].includes(parsed.protocol) ||
            isDirectory(result.url) ||
            urls.includes(parsed.href)
          ) {
            continue;
          }

          urls.push(parsed.href);
          if (urls.length >= 5) break;
        } catch {
          // Ungültige URLs überspringen.
        }
      }

      // 2. Webseiten mit Basic Extract auslesen.
      // Fehlgeschlagene URLs werden von Tavily nicht berechnet.
      let extractedResults = [];

      if (urls.length) {
        const extractResponse = await fetch("https://api.tavily.com/extract", {
          method: "POST",
          headers: tavilyHeaders,
          body: JSON.stringify({
            urls,
            extract_depth: "basic",
            format: "text",
            include_images: false,
            include_usage: true
          })
        });

        if (extractResponse.ok) {
          const extractData = await extractResponse.json();
          extractedResults = Array.isArray(extractData.results)
            ? extractData.results
            : [];
        }
        // Falls Extract fehlschlägt, werden die Suchtexte weiterverwendet.
      }

      const extractedByUrl = new Map(
        extractedResults.map(item => [item.url, item.raw_content || ""])
      );

      function extractAddress(text) {
        const value = String(text || "")
          .replace(/<\s*br\s*\/?>/gi, "\n")
          .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;|&#160;/gi, " ")
          .replace(/&amp;/gi, "&");

        // Support house-number ranges and both spaced and abbreviated street names,
        // including compound abbreviations such as "Nördliche Hauptstr. 17–19".
        const streetPattern =
          /\b(?:[A-ZÄÖÜ][\p{L}.'-]*(?:straße|strasse|str\.?|weg|platz|gasse|allee|ufer|ring|chaussee|damm|steig)|[A-ZÄÖÜ][\p{L}.'-]*(?:[ \t]+[\p{L}.'-]+){0,4}[ \t]+(?:straße|strasse|straße|str\.?|weg|platz|gasse|allee|ufer|ring|chaussee|damm|steig))[ \t]+\d+[a-z]?(?:\s*[-–—/]\s*\d+[a-z]?)?\b/iu;

        const match = value.match(streetPattern);
        if (!match) return "";

        const after = value.slice(match.index + match[0].length);
        const postal = after.match(
          /^\s*[,;\n-]?\s*(\d{5}\s+[A-ZÄÖÜ][\p{L}-]+)/iu
        );

        return (
          match[0].replace(/\s*[-–—/]\s*/g, "–") +
          (postal ? ", " + postal[1] : "")
        ).replace(/\s+/g, " ").trim().slice(0, 180);
      }

      function extractTown(text) {
        const value = String(text || "")
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;|&#160;/gi, " ")
          .replace(/\bam\s+Tegernsee\b/gi, " ")
          .replace(/\s+/g, " ");

        // Postal-address evidence has priority over incidental town mentions.
        // Allow a hyphenated district after the municipality (e.g. Kreuth-Enterbach).
        const townPattern =
          "(Bad\\s+Wiessee|Rottach[-\\s]Egern|Schliersee|Kreuth|Gmund(?:\\s+am\\s+Tegernsee)?|Tegernsee)";
        const postal = value.match(
          new RegExp("\\b(?:83700|83703|83707|83708|83727)\\s+" + townPattern + "(?=\\b|[-,.;])", "i")
        );
        if (postal) {
          const town = postal[1].replace(/\s+/g, " ").trim();
          if (/^bad\s+wiessee$/i.test(town)) return "Bad Wiessee";
          if (/^rottach[-\s]egern$/i.test(town)) return "Rottach-Egern";
          if (/^gmund/i.test(town)) return "Gmund";
          return town.charAt(0).toUpperCase() + town.slice(1);
        }

        const contextual = value.match(
          new RegExp("\\b(?:in|bei|Ortsteil|OT)\\s+" + townPattern + "(?=\\b|[-,.;])", "i")
        );
        if (!contextual) return "";
        const town = contextual[1].replace(/\s+/g, " ").trim();
        if (/^bad\s+wiessee$/i.test(town)) return "Bad Wiessee";
        if (/^rottach[-\s]egern$/i.test(town)) return "Rottach-Egern";
        if (/^gmund/i.test(town)) return "Gmund";
        return town.charAt(0).toUpperCase() + town.slice(1);
      }

      function extractPhone(text) {
        const lines = String(text || "").split(/\r?\n/);

        for (const line of lines) {
          if (/\bfax\b/i.test(line)) continue;

          const labeled = line.match(
            /(?:Telefonnummer|Telefon|Tel\.?|Phone|Fon)\s*[:：]?\s*(\+?\s*\d[\d\s()./-]{5,}\d)/i
          );
          if (labeled) {
            return labeled[1].replace(/\s+/g, " ").trim().slice(0, 50);
          }

          const match = line.match(
            /(?:^|:\s*)(\+49\s*\(?0?\)?[\d\s()./-]{5,}\d|0\d{2,5}[\d\s()./-]{5,}\d)/
          );
          if (match) {
            return match[1].replace(/\s+/g, " ").trim().slice(0, 50);
          }
        }

        return "";
      }

      function extractEmail(text) {
        const match = String(text || "").match(
          /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
        );
        return match ? match[0] : "";
      }

      function extractCategory(text) {
        const value = String(text || "").toLocaleLowerCase("de");

        if (/almwirtschaft|alpengasthof|berghütte|alpe\b/.test(value)) {
          return "Almwirtschaft";
        }
        if (/bäckerei.*café|bäckerei.*cafe/.test(value)) {
          return "Bäckerei & Café";
        }
        if (/\bpizzeria\b/.test(value)) return "Pizzeria";
        if (/\beisdiele\b|eiscafé|eiscafe|gelateria/.test(value)) {
          return "Eisdiele";
        }
        if (/\bbiergarten\b/.test(value)) return "Biergarten";
        if (/\bkonditorei\b/.test(value)) return "Konditorei";
        if (/\bbrauerei\b/.test(value)) return "Brauerei";
        if (/\bcafé\b|\bcafe\b/.test(value)) return "Café";
        if (/\bgasthof\b/.test(value)) return "Gasthof";
        if (/\bwirtshaus\b/.test(value)) return "Wirtshaus";
        if (/hotelrestaurant|hotel.*restaurant/.test(value)) {
          return "Hotelrestaurant";
        }
        if (/\bimbiss\b|snackbar|fast food/.test(value)) return "Imbiss";
        if (/\brestaurant\b/.test(value)) return "Restaurant";

        return "";
      }

      function extractClosedDay(text) {
        const value = String(text || "")
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;|&#160;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/\s+/g, " ");
        const days = "Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag";
        const shortDays = "Mo(?:ntag)?|Di(?:enstag)?|Mi(?:ttwoch)?|Do(?:nnerstag)?|Fr(?:eitag)?|Sa(?:mstag)?|So(?:nntag)?";
        const pair = "(?:" + days + ")(?:\\s*(?:,|und|&|/)\\s*(?:" + days + "))?";
        const beforeRuhetag = value.match(new RegExp("\\b(" + days + ")(?:\\s*(?:,|und|&|/)\\s*(" + days + "))?\\b.{0,35}\\bRuhetag(?:e)?\\b", "i"));
        if (beforeRuhetag) return [beforeRuhetag[1], beforeRuhetag[2]].filter(Boolean).join(" und ");

        const afterRuhetag = value.match(new RegExp("\\bRuhetag(?:e)?\\s*[:：]?\\s*(" + days + ")(?:\\s*(?:,|und|&|/)\\s*(" + days + "))?\\b", "i"));
        if (afterRuhetag) return [afterRuhetag[1], afterRuhetag[2]].filter(Boolean).join(" und ");

        // Viele Restaurantseiten nennen Schließtage ohne das Wort "Ruhetag".
        const closed = value.match(new RegExp("\\b(" + days + ")(?:\\s*(?:,|und|&|/)\\s*(" + days + "))?\\s*(?:ist|sind)?\\s*(?:geschlossen|Betriebsferien)\\b", "i"));
        if (closed) return [closed[1], closed[2]].filter(Boolean).join(" und ");

        const shortClosed = value.match(new RegExp("\\b(" + shortDays + ")\\s*(?:,|/|&|und)\\s*(" + shortDays + ")\\s*(?:Ruhetag(?:e)?|geschlossen)\\b", "i"));
        if (shortClosed) {
          const expand = day => ({mo:"Montag",di:"Dienstag",mi:"Mittwoch",do:"Donnerstag",fr:"Freitag",sa:"Samstag",so:"Sonntag"})[day.slice(0,2).toLowerCase()];
          return [expand(shortClosed[1]), expand(shortClosed[2])].join(" und ");
        }
        return "";
      }


      function extractHours(text) {
        // HTML-Text in getrennte Textzeilen umwandeln, damit zusammengeklebte
        // Suchtreffer oder Bewertungsseiten nicht als Öffnungszeiten durchrutschen.
        const normalized = String(text || "")
          .replace(/<\s*br\s*\/?>/gi, "\n")
          .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;|&#160;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/[ \t]+/g, " ");

        const lines = normalized
          .split(/\r?\n/)
          .flatMap(line => line.split(/(?<=[;|])\s*|\s+(?=(?:Öffnungszeiten|Öffnungszeit|Warme Küche|Küchenzeiten)\s*[:：])/i))
          .map(line => line.trim())
          .filter(Boolean);

        // Öffnungszeiten stehen oft nicht als Zeitspanne da, sondern z. B.
        // „Täglich ab 11:30 Uhr“ oder „Warme Küche bis 21:30 Uhr“.
        const hoursPattern =
          /(?:\b\d{1,2}(?:[:.]\d{2})?\s*(?:Uhr)?\s*(?:-|–|—|bis|\/)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:Uhr)?|\b(?:ab|bis)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:Uhr)?)/i;
        const dayPattern =
          /(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|\bMo\b|\bDi\b|\bMi\b|\bDo\b|\bFr\b|\bSa\b|\bSo\b|\btäglich\b|\btaeglich\b)/i;
        const noisePattern =
          /tripadvisor|bewertung|bewertungen|review|ratings?|out of \s*5|sterne|unhöflich|unhoeflich|unhofflich|rude service|left the place|extremely|food was|service was|image \d+/i;

        const openingLines = [];
        let kitchen = "";

        for (const rawLine of lines) {
          // Nie lange Fließtexte übernehmen: Öffnungszeiten müssen ein kurzer,
          // plausibler Eintrag sein und dürfen keine Bewertungsbegriffe enthalten.
          if (rawLine.length > 180 || noisePattern.test(rawLine)) continue;
          const line = rawLine.replace(/\s+/g, " ").trim();
          if (!hoursPattern.test(line)) continue;

          const isKitchen = /küche|kitchen/i.test(line);
          const isOpeningLabel = /^(?:öffnungszeiten|öffnungszeit)\b/i.test(line);
          const hasDay = dayPattern.test(line);
          if (!isKitchen && (hasDay || isOpeningLabel) &&
              !/speisekarte|reservier|bewertung|review/i.test(line)) {
            const candidate = line.replace(/^öffnungszeiten\s*[:：]?\s*/i, "").slice(0, 150);
            // Ein vollständiger Wochenplan hat Vorrang vor pauschalen Angaben wie
            // „Täglich ab 11:30 Uhr“. Mehrere einzelne Wochentage werden gesammelt.
            const specificDay = /(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|\bMo\b|\bDi\b|\bMi\b|\bDo\b|\bFr\b|\bSa\b|\bSo\b)/i.test(candidate);
            const genericDaily = /\b(?:täglich|taeglich|jeden\s+tag)\b/i.test(candidate);
            if (specificDay && !genericDaily) openingLines.push(candidate);
            else if (!openingLines.length) openingLines.push(candidate);
          }
          if (isKitchen && !kitchen) {
            // Nur den Küchenzeit-Abschnitt speichern, nicht davor stehende
            // Öffnungszeiten oder Ruhetage derselben Textzeile übernehmen.
            const kitchenStart = line.search(/(?:warme\s+küche|küchenzeiten|küche|kitchen)/i);
            const kitchenText = kitchenStart >= 0 ? line.slice(kitchenStart) : line;
            kitchen = kitchenText
              .replace(/^(?:warme\s+)?küche(?:nzeiten)?\s*[:：]?\s*/i, "")
              .replace(/^kitchen\s*[:：]?\s*/i, "")
              .trim()
              .slice(0, 150);
          }
        }

        // Doppelte Zeilen aus Suchtreffern entfernen. Wenn sowohl konkrete Tage
        // als auch „täglich ab ...“ vorkommen, nur die konkreten Tage verwenden.
        const specificOpenings = [...new Set(openingLines)].filter(line =>
          /(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|\bMo\b|\bDi\b|\bMi\b|\bDo\b|\bFr\b|\bSa\b|\bSo\b)/i.test(line) &&
          !/\b(?:täglich|taeglich|jeden\s+tag)\b/i.test(line)
        );
        const finalOpenings = specificOpenings.length ? specificOpenings : [...new Set(openingLines)];
        return {
          opening: finalOpenings.join("; ").slice(0, 150),
          kitchen: kitchen.slice(0, 150)
        };
      }

      // Extrahierte Webseiteninhalte mit Suchtexten zusammenführen.
      const records = relevant.map(result => {
        const url = String(result.url || "");
        const extracted = extractedByUrl.get(url) || "";
        const content = [
          result.title || "",
          extracted,
          result.content || ""
        ].filter(Boolean).join("\n").slice(0, 12000);

        const hours = extractHours(content);
        return {
          title: String(result.title || cleanName).slice(0, 180),
          url,
          content,
          adresse: extractAddress(content),
          ort: extractTown(content),
          telefon: extractPhone(content),
          email: extractEmail(content),
          kategorie: extractCategory(
            String(result.title || "") + "\n" + content
          ),
          oeffnungszeiten: hours.opening,
          kuechenzeiten: hours.kitchen,
          ruhetag: extractClosedDay(content),
          website: url && !isDirectory(url) ? url : ""
        };
      });

      function firstValue(field) {
        // Bei Öffnungszeiten konkrete Wochentagsangaben immer vor pauschalen
        // Aussagen wie "Täglich ab 11:30 Uhr" bevorzugen.
        if (field === "oeffnungszeiten") {
          const specific = records.find(record => {
            const value = String(record[field] || "").trim();
            return value &&
              /(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|\\bMo\\b|\\bDi\\b|\\bMi\\b|\\bDo\\b|\\bFr\\b|\\bSa\\b|\\bSo\\b)/i.test(value) &&
              !/\\b(?:täglich|taeglich|jeden\\s+tag)\\b/i.test(value);
          });
          if (specific) return String(specific[field]).trim();
        }
        // Küchenzeiten können in einer Quelle verkürzt und in einer anderen
        // vollständig stehen. Nicht blind den ersten Treffer übernehmen:
        // Angaben mit einer Sonntags-Ausnahme haben Vorrang, danach die
        // ausführlichste gefundene Küchenzeit.
        if (field === "kuechenzeiten") {
          const kitchenValues = [...new Set(records
            .map(record => String(record[field] || "").trim())
            .filter(Boolean))];
          kitchenValues.sort((a, b) => {
            const aSunday = /sonntags?|sonntag/i.test(a) ? 1 : 0;
            const bSunday = /sonntags?|sonntag/i.test(b) ? 1 : 0;
            return bSunday - aSunday || b.length - a.length;
          });
          if (kitchenValues.length) return kitchenValues[0];
        }
        for (const record of records) {
          const value = String(record[field] || "").trim();
          if (value) return value;
        }
        return "";
      }

      const sources = records.map(record => ({
        title: record.title,
        url: record.url,
        extracted: extractedByUrl.has(record.url)
      }));

      // Kartenlinks nur übernehmen, wenn sie von der offiziellen Website stammen
      // oder von dieser ausdrücklich verlinkt werden. Suchtreffer allein reichen nicht.
      function hostKey(value) {
        try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); }
        catch { return ""; }
      }

      function specialScore(url, title, kind) {
        let parsed;
        try { parsed = new URL(url); } catch { return 0; }
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return 0;
        const path = normalize(parsed.pathname + " " + parsed.search);
        const label = normalize(title || "");
        let score = 0;
        if (kind === "speisekarte") {
          if (/speisekarte|speise karte|menu|menue|mittagstisch|tageskarte/.test(path)) score += 12;
          if (/speisekarte|speise karte|menu|menue|tageskarte/.test(label)) score += 8;
        } else if (kind === "getraenkekarte") {
          if (/getrankekarte|getranke karte|getraenkekarte|drink.?menu|beverage.?menu/.test(path)) score += 15;
          if (/getrankekarte|getranke karte|getraenkekarte|drink.?menu|beverage.?menu/.test(label)) score += 10;
        } else if (kind === "reservierung") {
          if (/reservierung|reservieren|booking|book.?a.?table|table.?reservation/.test(path)) score += 15;
          if (/reservierung|reservieren|book.?a.?table|table.?reservation/.test(label)) score += 10;
          if (/thefork\.|opentable\.|quandoo\.|resmio\./.test(parsed.hostname.toLowerCase())) score += 12;
        }
        if (isDirectory(url)) score -= 4;
        else score += 2;
        return score;
      }

      const officialWebsite = firstValue("website");
      const officialHost = hostKey(officialWebsite);
      const officiallyLinked = new Map();
      const crawledPages = new Set();
      const pageQueue = [];
      const officialPageContents = [];
      if (officialWebsite && officialHost) pageQueue.push(officialWebsite);

      // Fetch only the selected public website and its same-host HTML pages.
      // Third-party URLs are eligible only if the official site links to them.
      for (let pageNo = 0; pageNo < 5 && pageQueue.length; pageNo++) {
        const pageUrl = pageQueue.shift();
        let parsedPage;
        try { parsedPage = new URL(pageUrl); } catch { continue; }
        if (hostKey(pageUrl) !== officialHost || !["http:", "https:"].includes(parsedPage.protocol)) continue;
        const pageKey = parsedPage.href.split("#")[0];
        if (crawledPages.has(pageKey)) continue;
        crawledPages.add(pageKey);
        try {
          const response = await fetch(pageKey, {
            redirect: "follow",
            headers: { "Accept": "text/html" },
            signal: AbortSignal.timeout(5000)
          });
          // Redirects must stay on the same official host.
          if (!response.ok || hostKey(response.url || pageKey) !== officialHost ||
              !/^text\/html\b/i.test(response.headers.get("content-type") || "")) continue;
          const html = (await response.text()).slice(0, 800000);

          // Die offizielle Seite auch als Fallback für fehlende Formularfelder nutzen.
          const plainText = html
            .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
            .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
            .replace(/<\s*br\s*\/?>/gi, "\n")
            .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article)\s*>/gi, "\n")
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;|&#160;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&quot;|&#34;/gi, '"')
            .replace(/&#39;|&apos;/gi, "'")
            .replace(/&uuml;/gi, "ü").replace(/&ouml;/gi, "ö").replace(/&auml;/gi, "ä")
            .replace(/&Uuml;/g, "Ü").replace(/&Ouml;/g, "Ö").replace(/&Auml;/g, "Ä")
            .replace(/&szlig;/gi, "ß")
            .replace(/[ \t]+/g, " ")
            .replace(/\n[ \t]+/g, "\n")
            .slice(0, 100000);

          if (plainText.trim()) {
            officialPageContents.push({
              url: response.url || pageKey,
              title: "Offizielle Website – ausgelesen",
              content: plainText
            });
          }
          const baseTag = html.match(/<base\s+[^>]*href\s*=\s*["']([^"']+)["']/i);
          let baseUrl = response.url || pageKey;
          if (baseTag) {
            try { const b = new URL(baseTag[1], pageKey); if (hostKey(b.href) === officialHost) baseUrl = b.href; } catch {}
          }
          const anchorRe = /<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a\s*>/gi;
          let match;
          while ((match = anchorRe.exec(html)) !== null) {
            const attrs = match[1] + " " + match[3];
            const rawHref = match[2].replace(/&amp;/gi, "&").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"');
            const attrLabel = (attrs.match(/(?:title|aria-label)\s*=\s*["']([^"']*)["']/i) || [,""])[1];
            const label = (match[4].replace(/<[^>]*>/g, " ") + " " + attrLabel).replace(/\s+/g, " ").trim().slice(0, 240);
            let target;
            try { target = new URL(rawHref, baseUrl); } catch { continue; }
            if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) continue;
            const normalizedUrl = target.href.split("#")[0];
            officiallyLinked.set(normalizedUrl, label);
            if (hostKey(normalizedUrl) === officialHost &&
                /speisekarte|speise.?karte|menu|menue|getränke|getraenke|drink|reservier|booking/i.test(label + " " + target.pathname) &&
                !crawledPages.has(normalizedUrl) && pageQueue.length < 4) pageQueue.push(normalizedUrl);
          }
        } catch { /* Unavailable official sites produce no unverified menu link. */ }
      }

      // Offizielle Website-Texte als zusätzliche Fallback-Datensätze anhängen.
      // Bereits gefundene Werte bleiben bevorzugt; nur leere Felder werden ergänzt.
      for (const page of officialPageContents) {
        const hours = extractHours(page.content);
        records.push({
          title: page.title,
          url: page.url,
          content: page.content,
          adresse: extractAddress(page.content),
          ort: extractTown(page.content),
          telefon: extractPhone(page.content),
          email: extractEmail(page.content),
          kategorie: extractCategory(page.title + "\\n" + page.content),
          oeffnungszeiten: hours.opening,
          kuechenzeiten: hours.kitchen,
          ruhetag: extractClosedDay(page.content),
          website: officialWebsite
        });
        sources.push({ title: page.title, url: page.url, extracted: true });
      }

      function findSpecialUrl(kind) {
        const candidates = [];
        for (const record of records) {
          const host = hostKey(record.url);
          const officialProof = Boolean(host && host === officialHost);
          const explicitLink = officiallyLinked.has(record.url);
          if (!officialProof && !explicitLink) continue;
          const score = specialScore(record.url, (officiallyLinked.get(record.url) || "") + " " + record.title, kind);
          if (score >= 10) candidates.push({ url: record.url, score: score + (officialProof ? 4 : 0) });
        }
        for (const [url, label] of officiallyLinked) {
          const score = specialScore(url, label, kind);
          if (score >= 10) candidates.push({ url, score: score + 8 });
        }
        candidates.sort((a, b) => b.score - a.score);
        return candidates.length ? candidates[0].url : "";
      }

      const speisekarte_url = findSpecialUrl("speisekarte");
      const getraenkekarte_url = findSpecialUrl("getraenkekarte");
      const reservierung_url = findSpecialUrl("reservierung");
      const kitchenHours = firstValue("kuechenzeiten");
      const notes = kitchenHours ? "Küchenzeiten: " + kitchenHours : "";

      return [{
        name: cleanName,
        // Prefer a town extracted from a source that contains a postal address.
        // This prevents a stray mention of another Tegernsee town from winning.
        ort: (records.find(record =>
          record.ort &&
          /\b(?:83700|83703|83707|83708|83727)\s+/i.test(record.content)
        ) || {}).ort || firstValue("ort"),
        kategorie: firstValue("kategorie"),
        adresse: firstValue("adresse"),
        telefon: firstValue("telefon"),
        website: firstValue("website"),
        email: firstValue("email"),
        oeffnungszeiten: firstValue("oeffnungszeiten"),
        ruhetag: firstValue("ruhetag"),
        notizen: notes.slice(0, 2200),
        reservierung: reservierung_url,
        speisekarte_url,
        getraenkekarte_url,
        bild: "",
        quellen: sources
          .filter(source => /^https?:\/\//i.test(source.url || ""))
          .slice(0, 5)
          .map(source => ({
            title: String(source.title || "").slice(0, 180),
            url: source.url,
            extracted: Boolean(source.extracted)
          }))
      }];
    }

    // --------------------------------------------------
    // API-ROUTEN
    // --------------------------------------------------

    try {
      // Gemeinsame Metadaten für Speise- und Getränkekarten.
      await turso(`CREATE TABLE IF NOT EXISTS restaurant_cards (
        restaurant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        object_key TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL DEFAULT '',
        mime_type TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (restaurant_id, kind)
      )`);
      await turso(`CREATE TABLE IF NOT EXISTS restaurant_card_files (
        restaurant_id TEXT NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/pdf', file_data BLOB NOT NULL,
        updated_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (restaurant_id, kind)
      )`);
      await turso(`CREATE TABLE IF NOT EXISTS restaurant_gallery_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        restaurant_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'image/webp',
        file_data BLOB NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT ''
      )`);
      const galleryColumns = await turso("PRAGMA table_info(restaurant_gallery_images)", [], true);
      const galleryColumnNames = (galleryColumns?.results?.[0]?.response?.result?.rows || []).map(row => String(rowValue(row[1]) || ""));
      if (!galleryColumnNames.includes("caption")) {
        await turso("ALTER TABLE restaurant_gallery_images ADD COLUMN caption TEXT NOT NULL DEFAULT ''");
      }

      await turso(`CREATE TABLE IF NOT EXISTS title_image_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1), filename TEXT NOT NULL,
        mime_type TEXT NOT NULL, file_data BLOB NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
      )`);

      await turso(`CREATE TABLE IF NOT EXISTS title_text_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        title TEXT NOT NULL DEFAULT 'Tegernsee',
        subtitle TEXT NOT NULL DEFAULT 'Entdecken. Genießen. Wohlfühlen.',
        updated_at TEXT NOT NULL DEFAULT ''
      )`);

      // Bestehende Restaurantdaten bleiben unverändert; fehlende Spalten werden
      // beim ersten API-Aufruf rückwärtskompatibel ergänzt.
      const restaurantColumns = await turso("PRAGMA table_info(restaurants)", [], true);
      const existingColumns = (restaurantColumns?.results?.[0]?.response?.result?.rows || [])
        .map(row => String(rowValue(row[1]) || ""));
      if (!existingColumns.includes("betriebsferien_start")) {
        try {
          await turso("ALTER TABLE restaurants ADD COLUMN betriebsferien_start TEXT NOT NULL DEFAULT ''");
        } catch (error) {
          if (!/duplicate column name/i.test(String(error?.message || error))) throw error;
        }
      }
      if (!existingColumns.includes("betriebsferien_ende")) {
        try {
          await turso("ALTER TABLE restaurants ADD COLUMN betriebsferien_ende TEXT NOT NULL DEFAULT ''");
        } catch (error) {
          if (!/duplicate column name/i.test(String(error?.message || error))) throw error;
        }
      }
      if (!existingColumns.includes("externer_eintrag")) {
        try {
          await turso("ALTER TABLE restaurants ADD COLUMN externer_eintrag TEXT NOT NULL DEFAULT ''");
        } catch (error) {
          if (!/duplicate column name/i.test(String(error?.message || error))) throw error;
        }
      }
      if (!existingColumns.includes("zahlungsarten")) {
        try {
          await turso("ALTER TABLE restaurants ADD COLUMN zahlungsarten TEXT NOT NULL DEFAULT '[]'");
        } catch (error) {
          if (!/duplicate column name/i.test(String(error?.message || error))) throw error;
        }
      }
      if (!existingColumns.includes("zahlungsarten_status")) {
        try {
          await turso("ALTER TABLE restaurants ADD COLUMN zahlungsarten_status TEXT NOT NULL DEFAULT ''");
        } catch (error) {
          if (!/duplicate column name/i.test(String(error?.message || error))) throw error;
        }
      }

      await turso(`CREATE TABLE IF NOT EXISTS restaurant_payment_research_status (
        item_name TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('open', 'done', 'deleted')),
        updated_at TEXT NOT NULL DEFAULT ''
      )`);

      await turso(`CREATE TABLE IF NOT EXISTS restaurant_payment_requests (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        sent_at TEXT NOT NULL DEFAULT '',
        response_status TEXT NOT NULL DEFAULT 'pending' CHECK (response_status IN ('pending', 'received')),
        payment_methods TEXT NOT NULL DEFAULT '[]',
        response_note TEXT NOT NULL DEFAULT '',
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT ''
      )`);

      await turso(`CREATE TABLE IF NOT EXISTS restaurant_gmail_oauth_state (
        state TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )`);
      await turso(`CREATE TABLE IF NOT EXISTS restaurant_gmail_connection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        email TEXT NOT NULL DEFAULT '',
        refresh_token_encrypted TEXT NOT NULL,
        connected_at TEXT NOT NULL
      )`);

      if (request.method === "GET") {
        const url = new URL(request.url);
        const action = url.searchParams.get("action");

        if (action === "gmailOAuthCallback") {
          const htmlPage = (title, message) => new Response(
            `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;background:#f5f3eb;color:#20382e;padding:32px;max-width:620px;margin:40px auto"><h2>${title}</h2><p>${message}</p><p><a href="https://msc2604.github.io/tegernsee-lieblinge/" style="color:#2d6a56;font-weight:700">Zur Restaurant-App</a></p></body></html>`,
            { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }
          );
          try {
            if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REDIRECT_URI || !env.GMAIL_TOKEN_ENCRYPTION_KEY) {
              return htmlPage("Einrichtung noch nicht vollständig", "Die Gmail-Verbindung ist serverseitig noch nicht vollständig eingerichtet. Bitte kehre zur App zurück.");
            }
            const code = url.searchParams.get("code") || "";
            const state = url.searchParams.get("state") || "";
            const googleError = url.searchParams.get("error");
            if (googleError) return htmlPage("Verbindung abgebrochen", "Google hat die Freigabe nicht abgeschlossen. Du kannst es in der App erneut versuchen.");
            if (!code || !state) return htmlPage("Verbindung fehlgeschlagen", "Die Rückmeldung von Google war unvollständig.");
            const stateResult = await turso("SELECT created_at FROM restaurant_gmail_oauth_state WHERE state = ?", [textArg(state)], true);
            const stateRow = stateResult?.results?.[0]?.response?.result?.rows?.[0];
            await turso("DELETE FROM restaurant_gmail_oauth_state WHERE state = ?", [textArg(state)]);
            const createdAt = stateRow ? Date.parse(String(rowValue(stateRow[0]) || "")) : NaN;
            if (!Number.isFinite(createdAt) || Date.now() - createdAt > 10 * 60 * 1000 || createdAt > Date.now() + 60 * 1000) {
              return htmlPage("Sicherheitsprüfung fehlgeschlagen", "Die Freigabe ist abgelaufen oder ungültig. Bitte starte die Verbindung erneut in der App.");
            }
            const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                code,
                client_id: env.GMAIL_CLIENT_ID,
                client_secret: env.GMAIL_CLIENT_SECRET,
                redirect_uri: env.GMAIL_REDIRECT_URI,
                grant_type: "authorization_code"
              })
            });
            const tokenData = await tokenResponse.json();
            if (!tokenResponse.ok || !tokenData.refresh_token) {
              console.log("Gmail OAuth token exchange failed:", tokenData.error || tokenResponse.status);
              return htmlPage("Gmail konnte nicht verbunden werden", "Google hat kein dauerhaftes Verbindungstoken geliefert. Bitte prüfe die Google-OAuth-Einstellungen und versuche es erneut.");
            }
            const profileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
              headers: { Authorization: "Bearer " + tokenData.access_token }
            });
            const profile = await profileResponse.json();
            if (!profileResponse.ok || !profile.emailAddress) {
              return htmlPage("Gmail-Konto konnte nicht bestätigt werden", "Google hat die Verbindung hergestellt, aber die zugehörige E-Mail-Adresse konnte nicht gelesen werden.");
            }
            const keyMaterial = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.GMAIL_TOKEN_ENCRYPTION_KEY));
            const cryptoKey = await crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["encrypt"]);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, new TextEncoder().encode(tokenData.refresh_token));
            const bytes = new Uint8Array(encrypted);
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            const cipherText = btoa(binary);
            const ivText = btoa(String.fromCharCode(...iv));
            const connectedAt = new Date().toISOString();
            await turso(
              `INSERT INTO restaurant_gmail_connection (id, email, refresh_token_encrypted, connected_at)
               VALUES (1, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET email = excluded.email, refresh_token_encrypted = excluded.refresh_token_encrypted, connected_at = excluded.connected_at`,
              [textArg(profile.emailAddress), textArg(ivText + "." + cipherText), textArg(connectedAt)]
            );
            return htmlPage("Gmail erfolgreich verbunden", "Das Google-Konto " + String(profile.emailAddress).replace(/[&<>"]/g, "") + " wurde sicher mit der Restaurant-App verbunden. Die App kann E-Mails nur lesen; sie versendet, verändert oder löscht keine Nachrichten.");
          } catch (error) {
            console.log("Gmail OAuth callback error:", String(error?.message || error));
            return htmlPage("Gmail-Verbindung fehlgeschlagen", "Beim Abschließen der Verbindung ist ein technischer Fehler aufgetreten. Bitte versuche es später erneut.");
          }
        }

        if (action === "paymentResearchStatus") {
          const result = await turso(
            "SELECT item_name, status, updated_at FROM restaurant_payment_research_status ORDER BY item_name",
            [],
            true
          );
          const rows = result?.results?.[0]?.response?.result?.rows || [];
          return json({
            items: rows.map(row => ({
              name: String(rowValue(row[0]) || ""),
              status: String(rowValue(row[1]) || ""),
              updatedAt: String(rowValue(row[2]) || "")
            }))
          });
        }

        if (action === "paymentRequestTracker") {
          const result = await turso(
            "SELECT id, name, email, sent_at, response_status, payment_methods, response_note, updated_at FROM restaurant_payment_requests WHERE deleted = 0 ORDER BY sent_at DESC, name COLLATE NOCASE",
            [],
            true
          );
          const rows = result?.results?.[0]?.response?.result?.rows || [];
          return json({
            items: rows.map(row => {
              let methods = [];
              try {
                const parsed = JSON.parse(String(rowValue(row[5]) || "[]"));
                if (Array.isArray(parsed)) methods = parsed.filter(value => ["cash", "girocard", "visa", "mastercard"].includes(value));
              } catch {}
              return {
                id: String(rowValue(row[0]) || ""),
                name: String(rowValue(row[1]) || ""),
                email: String(rowValue(row[2]) || ""),
                sentAt: String(rowValue(row[3]) || ""),
                status: String(rowValue(row[4]) || "pending"),
                methods,
                note: String(rowValue(row[6]) || ""),
                updatedAt: String(rowValue(row[7]) || "")
              };
            })
          });
        }

        if (action === "galleryCounts") {
          const result = await turso("SELECT restaurant_id, COUNT(*) FROM restaurant_gallery_images GROUP BY restaurant_id", [], true);
          const rows = result?.results?.[0]?.response?.result?.rows || [];
          return json(rows.map(row=>({restaurantId:String(rowValue(row[0])||""),count:Number(rowValue(row[1])||0)})));
        }

        if (action === "gallery") {
          const restaurantId = (url.searchParams.get("restaurantId") || "").trim();
          if (!restaurantId) return json({error:"Restaurant-ID fehlt."},400);
          const result = await turso("SELECT id, filename, mime_type, sort_order, caption FROM restaurant_gallery_images WHERE restaurant_id = ? ORDER BY sort_order, id",[textArg(restaurantId)],true);
          const rows = result?.results?.[0]?.response?.result?.rows || [];
          return json(rows.map(row=>({id:rowValue(row[0]),filename:rowValue(row[1]),mimeType:rowValue(row[2]),sortOrder:rowValue(row[3]),caption:rowValue(row[4])||"",url:"?action=galleryImage&restaurantId="+encodeURIComponent(restaurantId)+"&imageId="+encodeURIComponent(rowValue(row[0]))})));
        }

        if (action === "galleryImage") {
          const restaurantId=(url.searchParams.get("restaurantId")||"").trim();
          const imageId=Number(url.searchParams.get("imageId")||0);
          if(!restaurantId||!Number.isSafeInteger(imageId)||imageId<1) return json({error:"Bildangabe ungültig."},400);
          const result=await turso("SELECT filename,mime_type,file_data FROM restaurant_gallery_images WHERE restaurant_id=? AND id=?",[textArg(restaurantId),integerArg(imageId)],true);
          const row=result?.results?.[0]?.response?.result?.rows?.[0];
          if(!row) return json({error:"Bild nicht gefunden."},404);
          const mime=String(rowValue(row[1])||"");
          if(!["image/webp","image/jpeg","image/png"].includes(mime)) return json({error:"Ungültiger Bildtyp."},500);
          const raw=row[2], encoded=raw&&typeof raw==="object"?(raw.base64||raw.value||""):String(raw||"");
          if(!encoded) return json({error:"Bilddatei ist leer."},500);
          let bytes; try{const binary=atob(encoded);bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);}catch{return json({error:"Bilddatei kann nicht gelesen werden."},500);}
          return new Response(bytes,{status:200,headers:{...corsHeaders,"Content-Type":mime,"Content-Length":String(bytes.length),"Cache-Control":"public, max-age=3600","X-Content-Type-Options":"nosniff"}});
        }

        if (action === "cardFile") {
          const restaurantId = (url.searchParams.get("restaurantId") || "").trim();
          const kind = (url.searchParams.get("kind") || "").trim();
          if (!restaurantId || !["speisekarte", "getraenkekarte", "dessertkarte", "brotzeitkarte", "saisonkarte"].includes(kind)) return json({error:"Restaurant oder Kartenart ist ungültig."},400);
          const result = await turso("SELECT filename, mime_type, file_data FROM restaurant_card_files WHERE restaurant_id = ? AND kind = ?",[textArg(restaurantId),textArg(kind)],true);
          const row = result?.results?.[0]?.response?.result?.rows?.[0];
          if (!row) return json({error:"Für diese Karte ist keine PDF-Datei gespeichert."},404);
          const raw = row[2];
          const encoded = raw && typeof raw === "object" ? (raw.base64 || raw.value || "") : String(raw || "");
          if (!encoded) return json({error:"Die gespeicherte PDF-Datei ist leer oder ungültig."},500);
          let bytes;
          try { const binary = atob(encoded); bytes = new Uint8Array(binary.length); for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i); }
          catch { return json({error:"Die PDF-Datei konnte nicht gelesen werden."},500); }
          const filename = String(rowValue(row[0]) || "karte.pdf").replace(/[\\r\\n"\\\\]/g,"_").slice(0,120);
          return new Response(bytes,{status:200,headers:{...corsHeaders,"Content-Type":"application/pdf","Content-Length":String(bytes.length),"Content-Disposition":'inline; filename="'+filename+'"',"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
        }

        if (action === "titleText") {
          const result = await turso("SELECT title, subtitle FROM title_text_settings WHERE id = 1", [], true);
          const row = result?.results?.[0]?.response?.result?.rows?.[0];
          return json({
            title: row ? String(rowValue(row[0]) || "Tegernsee") : "Tegernsee",
            subtitle: row ? String(rowValue(row[1]) || "Entdecken. Genießen. Wohlfühlen.") : "Entdecken. Genießen. Wohlfühlen."
          });
        }

        if (action === "titleImage") {
          const result = await turso("SELECT filename, mime_type, file_data FROM title_image_settings WHERE id = 1", [], true);
          const row = result?.results?.[0]?.response?.result?.rows?.[0];
          if (!row) return json({error:"Noch kein Titelbild gespeichert."},404);
          const raw = row[2];
          const encoded = raw && typeof raw === "object" ? (raw.base64 || raw.value || "") : String(raw || "");
          if (!encoded) return json({error:"Das Titelbild ist leer oder ungültig."},500);
          let bytes;
          try { const binary=atob(encoded); bytes=new Uint8Array(binary.length); for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i); }
          catch { return json({error:"Das Titelbild konnte nicht gelesen werden."},500); }
          const mimeType=String(rowValue(row[1]) || "");
          if (!["image/webp","image/jpeg","image/png"].includes(mimeType)) return json({error:"Bildformat nicht erlaubt."},500);
          return new Response(bytes,{status:200,headers:{...corsHeaders,"Content-Type":mimeType,"Content-Length":String(bytes.length),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
        }

        if (action === "cards") {
          // Ensure the status table exists before the cards endpoint joins it.
          await turso(`CREATE TABLE IF NOT EXISTS restaurant_card_checks (
            restaurant_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            url TEXT NOT NULL,
            checked_at TEXT NOT NULL DEFAULT '',
            changed_at TEXT NOT NULL DEFAULT '',
            content_hash TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            detail TEXT NOT NULL DEFAULT '',
            notified_at TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (restaurant_id, kind)
          )`);
          try {
            await turso("ALTER TABLE restaurant_card_checks ADD COLUMN notified_at TEXT NOT NULL DEFAULT ''");
          } catch (error) {
            if (!/duplicate column/i.test(String(error?.message || error))) throw error;
          }
          const restaurantId = (url.searchParams.get("restaurantId") || "").trim();
          if (!restaurantId) return json({ error: "Restaurant-ID fehlt." }, 400);
          const result = await turso(
            `SELECT c.kind, c.url, q.checked_at, q.changed_at, q.status, q.detail, q.url, f.filename, f.mime_type
             FROM restaurant_cards c
             LEFT JOIN restaurant_card_checks q ON q.restaurant_id = c.restaurant_id AND q.kind = c.kind
             LEFT JOIN restaurant_card_files f ON f.restaurant_id = c.restaurant_id AND f.kind = c.kind
             WHERE c.restaurant_id = ?`,
            [textArg(restaurantId)], true
          );
          const rows = result?.results?.[0]?.response?.result?.rows || [];
          const cards = {};
          for (const row of rows) {
            const kind = String(rowValue(row[0]) || "");
            if (!["speisekarte", "getraenkekarte", "dessertkarte", "brotzeitkarte", "saisonkarte"].includes(kind)) continue;
            const cardUrl = rowValue(row[1]) || "";
            const checkedUrl = rowValue(row[6]) || "";
            // A LEFT JOIN can return a wrapped NULL for the file columns in some
            // LibSQL/Turso response formats. Never treat that wrapper as a real file.
            const rawFilename = rowValue(row[7]);
            const filename = typeof rawFilename === "string" ? rawFilename.trim() : "";
            const mimeTypeValue = rowValue(row[8]);
            const mimeType = typeof mimeTypeValue === "string" ? mimeTypeValue.trim() : "";
            cards[kind] = {
              url: cardUrl,
              checkedAt: checkedUrl === cardUrl ? (rowValue(row[2]) || "") : "",
              changedAt: checkedUrl === cardUrl ? (rowValue(row[3]) || "") : "",
              checkStatus: checkedUrl === cardUrl ? (rowValue(row[4]) || "") : "",
              checkDetail: checkedUrl === cardUrl ? (rowValue(row[5]) || "") : "",
              fileAvailable: filename.length > 0 && mimeType === "application/pdf",
              filename,
              mimeType
            };
          }
          return json({ cards });
        }

        if (action === "lookup") {
          const name = (url.searchParams.get("name") || "").trim();

          if (name.length < 2) {
            return json({ error: "Bitte mindestens zwei Zeichen eingeben." }, 400);
          }

          try {
            const candidates = await lookupRestaurant(name);
            return json({
              source: "Tavily Search + Extract",
              merged: true,
              candidates
            });
          } catch (error) {
            return json({
              error: "Die Recherche ist momentan nicht möglich.",
              message: error instanceof Error ? error.message : String(error)
            }, 502);
          }
        }

        if (action === "usage") {
          try {
            return json(await getTavilyUsage());
          } catch (error) {
            return json({
              available: false,
              error: "Der Tavily-Verbrauch konnte nicht abgerufen werden.",
              message: error instanceof Error ? error.message : String(error)
            }, 502);
          }
        }

        const result = await turso(
          `SELECT
            id, name, ort, kategorie, adresse, telefon, website, externer_eintrag,
            email, oeffnungszeiten, ruhetag, betriebsferien_start, betriebsferien_ende, notizen, bild, reservierung, zahlungsarten, zahlungsarten_status
          FROM restaurants
          ORDER BY name COLLATE NOCASE`,
          [],
          true
        );

        const rows = result?.results?.[0]?.response?.result?.rows || [];

        return json(rows.map(row => ({
          id: rowValue(row[0]),
          name: rowValue(row[1]),
          ort: rowValue(row[2]),
          kategorie: rowValue(row[3]),
          adresse: rowValue(row[4]),
          telefon: rowValue(row[5]),
          website: rowValue(row[6]),
          externer_eintrag: rowValue(row[7]),
          email: rowValue(row[8]),
          oeffnungszeiten: rowValue(row[9]),
          ruhetag: rowValue(row[10]),
          betriebsferien_start: rowValue(row[11]),
          betriebsferien_ende: rowValue(row[12]),
          notizen: rowValue(row[13]),
          bild: rowValue(row[14]),
          reservierung: rowValue(row[15]),
          zahlungsarten: (() => {
            try {
              const value = JSON.parse(String(rowValue(row[16]) || "[]"));
              return Array.isArray(value) ? value.filter(item => ["girocard", "debitkarte", "kreditkarte"].includes(item)) : [];
            } catch { return []; }
          })(),
          zahlungsarten_status: ["red","yellow","green"].includes(String(rowValue(row[17]) || "")) ? String(rowValue(row[17])) : ""
        })));
      }

      if (request.method === "POST") {
        if (!isAdmin(request)) {
          return json({ error: "Nicht autorisiert" }, 401);
        }

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "Ungültiger JSON-Inhalt" }, 400);
        }

        if (body.action === "savePaymentResearchStatus") {
          const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
          if (!items.length) return json({ error: "Keine Prüflistenänderungen übergeben." }, 400);
          const allowedStatuses = new Set(["open", "done", "deleted"]);
          const cleanItems = [];
          const seenNames = new Set();
          for (const item of items) {
            const name = String(item?.name || "").trim().slice(0, 160);
            const status = String(item?.status || "");
            if (!name || /[\u0000-\u001f]/.test(name) || !allowedStatuses.has(status)) {
              return json({ error: "Ungültiger Prüflisteneintrag." }, 400);
            }
            if (seenNames.has(name)) continue;
            seenNames.add(name);
            cleanItems.push({ name, status });
          }
          const now = new Date().toISOString();
          const placeholders = cleanItems.map(() => "(?, ?, ?)").join(", ");
          const args = cleanItems.flatMap(item => [textArg(item.name), textArg(item.status), textArg(now)]);
          await turso(
            `INSERT INTO restaurant_payment_research_status (item_name, status, updated_at)
             VALUES ${placeholders}
             ON CONFLICT(item_name) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
            args
          );
          const verify = await turso("SELECT item_name, status FROM restaurant_payment_research_status", [], true);
          const savedRows = verify?.results?.[0]?.response?.result?.rows || [];
          const saved = new Map(savedRows.map(row => [String(rowValue(row[0]) || ""), String(rowValue(row[1]) || "")]));
          if (!cleanItems.every(item => saved.get(item.name) === item.status)) {
            return json({ error: "Die Prüflistenänderungen konnten nicht vollständig bestätigt werden." }, 500);
          }
          return json({ success: true, verified: true, saved: cleanItems.length });
        }

        if (body.action === "gmailOAuthStart") {
          if (!env.GMAIL_CLIENT_ID || !env.GMAIL_REDIRECT_URI) {
            return json({ error: "Die Google-Client-ID und Weiterleitungsadresse müssen zuerst in Cloudflare eingerichtet werden." }, 503);
          }
          const stateBytes = crypto.getRandomValues(new Uint8Array(32));
          let stateBinary = "";
          for (const byte of stateBytes) stateBinary += String.fromCharCode(byte);
          const state = btoa(stateBinary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
          await turso("DELETE FROM restaurant_gmail_oauth_state WHERE created_at < ?", [textArg(new Date(Date.now() - 60 * 60 * 1000).toISOString())]);
          await turso("INSERT INTO restaurant_gmail_oauth_state (state, created_at) VALUES (?, ?)", [textArg(state), textArg(new Date().toISOString())]);
          const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
          authUrl.search = new URLSearchParams({
            client_id: env.GMAIL_CLIENT_ID,
            redirect_uri: env.GMAIL_REDIRECT_URI,
            response_type: "code",
            scope: "https://www.googleapis.com/auth/gmail.readonly",
            access_type: "offline",
            prompt: "consent",
            include_granted_scopes: "true",
            state
          }).toString();
          return json({ success: true, authUrl: authUrl.toString() });
        }

        if (body.action === "gmailScanPaymentReplies") {
          if (!env.GMAIL_TOKEN_ENCRYPTION_KEY || !env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
            return json({ error: "Die Gmail-Verbindung ist serverseitig nicht vollständig eingerichtet." }, 503);
          }
          const connectionResult = await turso(
            "SELECT email, refresh_token_encrypted FROM restaurant_gmail_connection WHERE id = 1",
            [],
            true
          );
          const connectionRow = connectionResult?.results?.[0]?.response?.result?.rows?.[0];
          if (!connectionRow) return json({ error: "Es ist noch kein Gmail-Konto verbunden." }, 409);

          const email = String(rowValue(connectionRow[0]) || "");
          const encryptedToken = String(rowValue(connectionRow[1]) || "");
          const tokenParts = encryptedToken.split(".");
          if (tokenParts.length !== 2) return json({ error: "Das gespeicherte Gmail-Token ist ungültig. Bitte verbinde Gmail erneut." }, 500);

          let refreshToken;
          try {
            const keyMaterial = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.GMAIL_TOKEN_ENCRYPTION_KEY));
            const cryptoKey = await crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["decrypt"]);
            const ivBinary = atob(tokenParts[0]);
            const cipherBinary = atob(tokenParts[1]);
            const iv = Uint8Array.from(ivBinary, char => char.charCodeAt(0));
            const cipher = Uint8Array.from(cipherBinary, char => char.charCodeAt(0));
            const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, cipher);
            refreshToken = new TextDecoder().decode(plain);
          } catch {
            return json({ error: "Das Gmail-Token konnte nicht entschlüsselt werden. Bitte prüfe den Verschlüsselungsschlüssel und verbinde Gmail gegebenenfalls erneut." }, 500);
          }

          const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: env.GMAIL_CLIENT_ID,
              client_secret: env.GMAIL_CLIENT_SECRET,
              refresh_token: refreshToken,
              grant_type: "refresh_token"
            })
          });
          const tokenData = await tokenResponse.json();
          if (!tokenResponse.ok || !tokenData.access_token) {
            console.log("Gmail refresh failed:", tokenData.error || tokenResponse.status);
            return json({ error: "Google konnte den Gmail-Zugriff nicht erneuern. Bitte verbinde Gmail erneut." }, 502);
          }

          const requestsResult = await turso(
            "SELECT id, name, email, sent_at FROM restaurant_payment_requests WHERE deleted = 0 AND response_status = 'pending' ORDER BY sent_at DESC",
            [],
            true
          );
          const requestRows = requestsResult?.results?.[0]?.response?.result?.rows || [];
          const pending = requestRows.map(row => ({
            id: String(rowValue(row[0]) || ""),
            name: String(rowValue(row[1]) || ""),
            email: String(rowValue(row[2]) || "").trim().toLowerCase(),
            sentAt: String(rowValue(row[3]) || "")
          })).filter(item => item.id && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email) && /^\d{4}-\d{2}-\d{2}/.test(item.sentAt));

          if (!pending.length) {
            return json({ success: true, account: email, scanned: 0, candidates: [], ambiguous: 0, message: "Es gibt keine offenen Anfragen mit gültiger E-Mail-Adresse." });
          }

          const earliest = Math.min(...pending.map(item => Date.parse(item.sentAt.slice(0, 10) + "T00:00:00Z")));
          const afterDate = new Date(earliest - 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "/");
          const uniqueEmails = [...new Set(pending.map(item => item.email))].slice(0, 100);
          const gmailQuery = "after:" + afterDate + " {" + uniqueEmails.map(address => "from:" + address).join(" ") + "}";
          const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
          listUrl.searchParams.set("q", gmailQuery);
          listUrl.searchParams.set("maxResults", "100");
          const listResponse = await fetch(listUrl.toString(), { headers: { Authorization: "Bearer " + tokenData.access_token } });
          const listData = await listResponse.json();
          if (!listResponse.ok) {
            console.log("Gmail message list failed:", listData.error?.message || listResponse.status);
            return json({ error: "Gmail-Nachrichten konnten nicht durchsucht werden." }, 502);
          }

          const byEmail = new Map();
          for (const item of pending) {
            if (!byEmail.has(item.email)) byEmail.set(item.email, []);
            byEmail.get(item.email).push(item);
          }
          const messageRefs = Array.isArray(listData.messages) ? listData.messages.slice(0, 100) : [];
          const candidates = [];
          let ambiguous = 0;
          let ignoredAutomatic = 0;
          const decodeBody = (encoded) => {
            if (!encoded) return "";
            try {
              const normalized = String(encoded).replace(/-/g, "+").replace(/_/g, "/");
              const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
              return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
            } catch { return ""; }
          };
          const collectParts = (part, output) => {
            if (!part) return;
            if (part.mimeType === "text/plain" && part.body?.data) output.push(decodeBody(part.body.data));
            if (Array.isArray(part.parts)) part.parts.forEach(child => collectParts(child, output));
            if (!part.parts?.length && part.mimeType === "text/html" && part.body?.data) {
              output.push(decodeBody(part.body.data).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'"));
            }
          };
          for (let offset = 0; offset < messageRefs.length; offset += 5) {
            const batch = messageRefs.slice(offset, offset + 5);
            const details = await Promise.all(batch.map(async ref => {
              const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent(ref.id) + "?format=full", {
                headers: { Authorization: "Bearer " + tokenData.access_token }
              });
              if (!response.ok) return null;
              return await response.json();
            }));
            for (const message of details.filter(Boolean)) {
              const headers = message.payload?.headers || [];
              const header = name => String(headers.find(item => String(item.name).toLowerCase() === name.toLowerCase())?.value || "");
              const fromHeader = header("From");
              const senderMatch = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
              const sender = String(senderMatch?.[1] || senderMatch?.[0] || "").trim().toLowerCase();
              const matches = byEmail.get(sender) || [];
              if (!matches.length) continue;
              const timestamp = Number(message.internalDate || 0);
              const eligible = matches.filter(item => timestamp >= Date.parse(item.sentAt.slice(0, 10) + "T00:00:00Z") - 12 * 60 * 60 * 1000);
              if (!eligible.length) continue;
              const parts = [];
              collectParts(message.payload, parts);
              const bodyText = (parts.join("\n") || String(message.snippet || "")).replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 5000);
              const subject = header("Subject");
              // Automatische Antworten (insbesondere Abwesenheitsnotizen) sind keine
              // inhaltlichen Antworten auf die Zahlungsarten-Anfrage und bleiben offen.
              const autoSubmitted = header("Auto-Submitted");
              const autoReplyHeader = header("X-Autoreply") || header("X-Autorespond") || header("X-Auto-Response-Suppress");
              const automaticSubject = /automatische\s+antwort|abwesenheitsnotiz|out\s+of\s+office|automatic\s+reply|auto(?:matic)?\s+response/i.test(subject);
              const automaticHeader = (autoSubmitted && !/^no$/i.test(autoSubmitted.trim())) ||
                (!!autoReplyHeader && !/^(no|false|0)$/i.test(autoReplyHeader.trim()));
              const awayBody = /(betriebsurlaub|ortsabwesenheit|abwesend|nicht im büro|out of office|currently away|currently out of office|on vacation|on holiday)/i.test(bodyText) &&
                /(ab dem|bis einschließlich|wieder für sie da|wieder erreichbar|e-mails?.*(gelesen|bearbeitet)|antwortung.*mehr zeit|beantwortung.*mehr zeit|return on|back on|will respond)/i.test(bodyText);
              if (automaticHeader || automaticSubject || awayBody) {
                ignoredAutomatic++;
                continue;
              }
              if (!/(zahlungsart|zahlung|kreditkarte|girocard|ec[- ]?karte|bargeld|visa|mastercard|barzahlung|karten)/i.test(subject + " " + bodyText)) continue;
              if (eligible.length !== 1) { ambiguous++; continue; }
              const requestItem = eligible[0];
              const methods = [];
              if (/(\bbargeld\b|\bbarzahlung\b|\bbar bezahlen\b|\bcash\b)/i.test(bodyText)) methods.push("cash");
              if (/(girocard|ec[- ]?karte|electronic cash|debitkarte)/i.test(bodyText)) methods.push("girocard");
              if (/\bvisa\b/i.test(bodyText)) methods.push("visa");
              if (/\bmastercard\b|\bmaster card\b/i.test(bodyText)) methods.push("mastercard");
              const receivedAt = timestamp ? new Date(timestamp).toISOString() : "";
              const note = ("E-Mail-Antwort vom " + (receivedAt ? new Date(receivedAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) : "unbekannt") +
                (subject ? " · Betreff: " + subject : "") + "\n" + bodyText).slice(0, 2000);
              candidates.push({
                id: requestItem.id,
                name: requestItem.name,
                sender,
                subject: subject.slice(0, 240),
                receivedAt,
                methods,
                note
              });
            }
          }
          const uniqueCandidates = [...new Map(candidates.map(item => [item.id + "|" + item.receivedAt, item])).values()];
          return json({
            success: true,
            account: email,
            scanned: messageRefs.length,
            candidates: uniqueCandidates.slice(0, 50),
            ambiguous,
            ignoredAutomatic,
            message: uniqueCandidates.length
              ? uniqueCandidates.length + " mögliche Antwort(en) gefunden. Bitte vor dem Speichern prüfen." + (ignoredAutomatic ? " " + ignoredAutomatic + " automatische Abwesenheits-/Systemnachricht(en) wurden ignoriert." : "")
              : "Keine eindeutig zuordenbaren Antworten zu den offenen Zahlungsarten-Anfragen gefunden." + (ignoredAutomatic ? " " + ignoredAutomatic + " automatische Abwesenheits-/Systemnachricht(en) wurden ignoriert." : "")
          });
        }

        if (body.action === "gmailConnectionStatus") {
          const result = await turso("SELECT email, connected_at FROM restaurant_gmail_connection WHERE id = 1", [], true);
          const row = result?.results?.[0]?.response?.result?.rows?.[0];
          return json({
            success: true,
            connected: !!row,
            email: row ? String(rowValue(row[0]) || "") : "",
            connectedAt: row ? String(rowValue(row[1]) || "") : ""
          });
        }

        if (body.action === "savePaymentRequestTracker") {
          const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
          if (!items.length) return json({ error: "Keine Anfragen-Einträge übergeben." }, 400);
          const allowedMethods = new Set(["cash", "girocard", "visa", "mastercard"]);
          const clean = [];
          const seen = new Set();
          for (const item of items) {
            const id = String(item?.id || "").trim().slice(0, 80);
            const name = String(item?.name || "").trim().slice(0, 160);
            const email = String(item?.email || "").trim().slice(0, 254);
            const sentAt = String(item?.sentAt || "").trim().slice(0, 30);
            const status = String(item?.status || "pending");
            const methods = Array.isArray(item?.methods) ? [...new Set(item.methods.filter(value => allowedMethods.has(value)))] : [];
            const note = String(item?.note || "").trim().slice(0, 2000);
            if (!id || !name || !email || !sentAt || !["pending", "received"].includes(status) ||
                /[\u0000-\u001f]/.test(id + name + email + sentAt) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(note)) {
              return json({ error: "Ungültiger Anfragen-Eintrag." }, 400);
            }
            if (seen.has(id)) continue;
            seen.add(id);
            clean.push({ id, name, email, sentAt, status, methods, note });
          }
          const now = new Date().toISOString();
          for (const item of clean) {
            await turso(
              `INSERT INTO restaurant_payment_requests
                (id, name, email, sent_at, response_status, payment_methods, response_note, deleted, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
               ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name, email = excluded.email, sent_at = excluded.sent_at,
                 response_status = excluded.response_status, payment_methods = excluded.payment_methods,
                 response_note = excluded.response_note, deleted = 0, updated_at = excluded.updated_at`,
              [textArg(item.id), textArg(item.name), textArg(item.email), textArg(item.sentAt),
               textArg(item.status), textArg(JSON.stringify(item.methods)), textArg(item.note), textArg(now)]
            );
          }
          const verify = await turso(
            "SELECT id FROM restaurant_payment_requests WHERE deleted = 0",
            [],
            true
          );
          const savedIds = new Set((verify?.results?.[0]?.response?.result?.rows || []).map(row => String(rowValue(row[0]) || "")));
          if (!clean.every(item => savedIds.has(item.id))) {
            return json({ error: "Die Anfragenliste konnte nicht vollständig bestätigt werden." }, 500);
          }
          return json({ success: true, verified: true, saved: clean.length });
        }

        if (body.action === "deletePaymentRequestTrackerItem") {
          const id = String(body.id || "").trim().slice(0, 80);
          if (!id) return json({ error: "Eintrags-ID fehlt." }, 400);
          await turso(
            "UPDATE restaurant_payment_requests SET deleted = 1, updated_at = ? WHERE id = ?",
            [textArg(new Date().toISOString()), textArg(id)]
          );
          const verify = await turso("SELECT deleted FROM restaurant_payment_requests WHERE id = ?", [textArg(id)], true);
          const row = verify?.results?.[0]?.response?.result?.rows?.[0];
          if (!row || Number(rowValue(row[0])) !== 1) return json({ error: "Der Eintrag konnte nicht gelöscht werden." }, 500);
          return json({ success: true, verified: true });
        }

        if (body.action === "runRestaurantMonitoringFullTest") {
          // Keep the HTTP request open until the complete run and email attempt finish.
          // A detached waitUntil task would be cancelled after 30 seconds for HTTP requests.
          const result = await runScheduledRestaurantMonitoring(env, ctx);
          if (!result?.completed) {
            return json({ success: false, completed: false, error: "Der Prüflauf wurde nicht vollständig ausgeführt." }, 500);
          }
          const emailSent = result.email?.sent === true;
          return json({
            success: emailSent,
            completed: true,
            emailSent,
            recipient: result.email?.recipient || "msc4021@arcor.de",
            emailReason: emailSent ? "" : (result.email?.reason || "Der E-Mail-Versand wurde nicht bestätigt."),
            summary: result.summary
          }, emailSent ? 200 : 502);
        }

        if (body.action === "sendRestaurantWebsiteTestEmail") {
          const result = await sendRestaurantWebsiteTestEmail({ env });
          if (!result.sent) {
            return json({ success: false, error: result.reason }, 400);
          }
          return json({
            success: true,
            acceptedByProvider: true,
            recipient: result.recipient,
            message: "Brevo hat die Testnachricht zum Versand angenommen."
          });
        }

        if (body.action === "startRestaurantWebsiteMonitor") {
          const missingBrevoSettings = [];
          if (!String(env.BREVO_API_KEY || "").trim()) missingBrevoSettings.push("BREVO_API_KEY");
          if (!String(env.BREVO_FROM_EMAIL || "").trim()) missingBrevoSettings.push("BREVO_FROM_EMAIL");
          if (missingBrevoSettings.length) {
            return json({
              success: false,
              configurationMissing: true,
              error: "E-Mail-Versand nicht bereit: In der Cloudflare-Worker-Umgebung fehlen " + missingBrevoSettings.join(", ") + ". Der Webseiten-Prüflauf wurde nicht gestartet. Bitte die Produktionseinstellungen prüfen."
            }, 412);
          }
          const runId = crypto.randomUUID();
          const startedAt = new Date().toISOString();
          const staleBefore = new Date(Date.now() - 30 * 60 * 1000).toISOString();
          await turso(`CREATE TABLE IF NOT EXISTS restaurant_website_monitor_runs (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            run_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'running',
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL DEFAULT '',
            report_json TEXT NOT NULL DEFAULT '{}',
            queue_json TEXT NOT NULL DEFAULT '[]',
            cursor INTEGER NOT NULL DEFAULT 0,
            batch_lock TEXT NOT NULL DEFAULT '',
            batch_lock_at TEXT NOT NULL DEFAULT ''
          )`);
          for (const migration of [
            "ALTER TABLE restaurant_website_monitor_runs ADD COLUMN queue_json TEXT NOT NULL DEFAULT '[]'",
            "ALTER TABLE restaurant_website_monitor_runs ADD COLUMN cursor INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE restaurant_website_monitor_runs ADD COLUMN batch_lock TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE restaurant_website_monitor_runs ADD COLUMN batch_lock_at TEXT NOT NULL DEFAULT ''"
          ]) {
            try { await turso(migration); } catch (error) {
              if (!String(error?.message || error).toLowerCase().includes("duplicate column")) throw error;
            }
          }
          await turso(`CREATE TABLE IF NOT EXISTS restaurant_site_snapshots (
            restaurant_id TEXT NOT NULL, page_url TEXT NOT NULL, checked_at TEXT NOT NULL DEFAULT '',
            content_hash TEXT NOT NULL DEFAULT '', extracted_data_json TEXT NOT NULL DEFAULT '{}',
            content_text TEXT NOT NULL DEFAULT '', PRIMARY KEY (restaurant_id, page_url)
          )`);
          await turso(`CREATE TABLE IF NOT EXISTS restaurant_change_proposals (
            id INTEGER PRIMARY KEY AUTOINCREMENT, restaurant_id TEXT NOT NULL, field_name TEXT NOT NULL,
            old_value TEXT NOT NULL DEFAULT '', new_value TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL,
            detected_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'accepted', 'rejected')), reviewed_at TEXT NOT NULL DEFAULT '',
            notified_at TEXT NOT NULL DEFAULT '',
            UNIQUE (restaurant_id, field_name, old_value, new_value)
          )`);
          await turso("CREATE INDEX IF NOT EXISTS idx_restaurant_change_proposals_status ON restaurant_change_proposals(status, detected_at)");
          const source = await turso(
            "SELECT id, name, website, externer_eintrag FROM restaurants ORDER BY name COLLATE NOCASE",
            [], true
          );
          const rows = source?.results?.[0]?.response?.result?.rows || [];
          const allRestaurants = rows.map(row => ({
            id: String(rowValue(row[0]) || ""), name: String(rowValue(row[1]) || ""),
            website: String(rowValue(row[2]) || "").trim(),
            externer_eintrag: String(rowValue(row[3]) || "").trim()
          })).filter(item => item.id);
          const restaurants = allRestaurants.filter(item => item.website);
          const externalEntries = allRestaurants.filter(item => item.externer_eintrag);
          const withoutWebsite = allRestaurants.filter(item => !item.website).map(item => item.name);
          const monitorQueue = [
            ...restaurants.map(item => ({ id:item.id, name:item.name, website:item.website, sourceType:"official" })),
            ...externalEntries.map(item => ({ id:item.id, name:item.name, website:item.externer_eintrag, sourceType:"external" }))
          ];
          const initialReport = {
            phase: "running", completed: 0, total: monitorQueue.length, activeRestaurants: [],
            restaurants: 0, externalEntries: 0, withoutWebsite, pages: 0, baselines: 0, proposals: 0, errors: []
          };
          await turso(`INSERT INTO restaurant_website_monitor_runs
            (id, run_id, status, started_at, finished_at, report_json, queue_json, cursor, batch_lock, batch_lock_at)
            VALUES (1, ?, 'running', ?, '', ?, ?, 0, '', '')
            ON CONFLICT(id) DO UPDATE SET
              run_id=excluded.run_id, status='running', started_at=excluded.started_at,
              finished_at='', report_json=excluded.report_json, queue_json=excluded.queue_json,
              cursor=0, batch_lock='', batch_lock_at=''
            WHERE restaurant_website_monitor_runs.status <> 'running'
              OR restaurant_website_monitor_runs.started_at < ?`,
            [textArg(runId), textArg(startedAt), textArg(JSON.stringify(initialReport)),
             textArg(JSON.stringify(monitorQueue)), textArg(staleBefore)]);
          const lock = await turso(
            "SELECT run_id, status, started_at FROM restaurant_website_monitor_runs WHERE id = 1",
            [], true
          );
          const lockRow = lock?.results?.[0]?.response?.result?.rows?.[0];
          if (!lockRow || String(rowValue(lockRow[0])) !== runId) {
            return json({ success: false, running: true, error: "Eine Webseitenprüfung läuft bereits.", startedAt: rowValue(lockRow?.[2]) || "" }, 409);
          }
          if (monitorQueue.length === 0) {
            const finishedAt = new Date().toISOString();
            await turso("UPDATE restaurant_website_monitor_runs SET status='completed', finished_at=? WHERE id=1 AND run_id=?",
              [textArg(finishedAt), textArg(runId)]);
          }
          return json({ success: true, started: true, runId, startedAt, total: monitorQueue.length });
        }

        if (body.action === "processRestaurantWebsiteMonitorBatch") {
          const runId = String(body.runId || "");
          if (!runId) return json({ error: "Prüflauf-ID fehlt." }, 400);
          const stateResult = await turso(
            "SELECT run_id, status, queue_json, cursor, report_json, batch_lock, batch_lock_at FROM restaurant_website_monitor_runs WHERE id = 1",
            [], true
          );
          const stateRow = stateResult?.results?.[0]?.response?.result?.rows?.[0];
          if (!stateRow || String(rowValue(stateRow[0])) !== runId) return json({ error: "Der Prüflauf ist nicht mehr aktuell." }, 409);
          if (String(rowValue(stateRow[1])) !== "running") return json({ success: true, finished: true });
          let queue = [], report = {};
          try { queue = JSON.parse(String(rowValue(stateRow[2]) || "[]")); } catch {}
          try { report = JSON.parse(String(rowValue(stateRow[4]) || "{}")); } catch {}
          const cursor = Math.max(0, Number(rowValue(stateRow[3])) || 0);
          if (cursor >= queue.length) {
            await turso("UPDATE restaurant_website_monitor_runs SET status='completed', finished_at=?, batch_lock='', batch_lock_at='' WHERE id=1 AND run_id=? AND status='running'",
              [textArg(new Date().toISOString()), textArg(runId)]);
            return json({ success: true, finished: true });
          }
          const now = new Date();
          const lockToken = crypto.randomUUID();
          const staleLock = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
          await turso(
            "UPDATE restaurant_website_monitor_runs SET batch_lock=?, batch_lock_at=? WHERE id=1 AND run_id=? AND status='running' AND (batch_lock='' OR batch_lock_at < ?)",
            [textArg(lockToken), textArg(now.toISOString()), textArg(runId), textArg(staleLock)]
          );
          const claimedResult = await turso(
            "SELECT batch_lock, cursor, queue_json, report_json FROM restaurant_website_monitor_runs WHERE id=1 AND run_id=?",
            [textArg(runId)], true
          );
          const claimed = claimedResult?.results?.[0]?.response?.result?.rows?.[0];
          if (!claimed || String(rowValue(claimed[0])) !== lockToken) {
            return json({ success: true, busy: true });
          }
          const claimedCursor = Math.max(0, Number(rowValue(claimed[1])) || 0);
          let claimedQueue = [];
          let cumulative = {};
          try { claimedQueue = JSON.parse(String(rowValue(claimed[2]) || "[]")); } catch {}
          try { cumulative = JSON.parse(String(rowValue(claimed[3]) || "{}")); } catch {}
          const restaurant = claimedQueue[claimedCursor];
          if (!restaurant) {
            await turso("UPDATE restaurant_website_monitor_runs SET status='completed', finished_at=?, batch_lock='', batch_lock_at='' WHERE id=1 AND run_id=? AND batch_lock=?",
              [textArg(new Date().toISOString()), textArg(runId), textArg(lockToken)]);
            return json({ success: true, finished: true });
          }
          cumulative = {
            phase: "running", completed: claimedCursor, total: claimedQueue.length,
            activeRestaurants: [String(restaurant.name || "Restaurant")],
            restaurants: Number(cumulative.restaurants) || 0,
            externalEntries: Number(cumulative.externalEntries) || 0,
            pages: Number(cumulative.pages) || 0,
            baselines: Number(cumulative.baselines) || 0, proposals: Number(cumulative.proposals) || 0,
            withoutWebsite: Array.isArray(cumulative.withoutWebsite) ? cumulative.withoutWebsite : [],
            errors: Array.isArray(cumulative.errors) ? cumulative.errors : []
          };
          await turso("UPDATE restaurant_website_monitor_runs SET report_json=? WHERE id=1 AND run_id=? AND batch_lock=?",
            [textArg(JSON.stringify(cumulative)), textArg(runId), textArg(lockToken)]);
          try {
            const result = await runRestaurantWebsiteMonitor({ db: turso, restaurants: [restaurant] });
            cumulative.restaurants += Number(result.restaurants) || 0;
            cumulative.externalEntries += Number(result.externalEntries) || 0;
            cumulative.pages += Number(result.pages) || 0;
            cumulative.baselines += Number(result.baselines) || 0;
            cumulative.proposals += Number(result.proposals) || 0;
            if (Array.isArray(result.errors)) cumulative.errors.push(...result.errors);
            cumulative.completed = claimedCursor + 1;
            cumulative.activeRestaurants = [];
            const finished = cumulative.completed >= claimedQueue.length;
            cumulative.phase = finished ? "completed" : "running";
            await turso(
              "UPDATE restaurant_website_monitor_runs SET cursor=?, report_json=?, status=?, finished_at=?, batch_lock='', batch_lock_at='' WHERE id=1 AND run_id=? AND batch_lock=?",
              [integerArg(cumulative.completed), textArg(JSON.stringify(cumulative)),
               textArg(finished ? "completed" : "running"),
               textArg(finished ? new Date().toISOString() : ""), textArg(runId), textArg(lockToken)]
            );
            let emailReport = null;
            if (finished) {
              try {
                emailReport = await sendRestaurantWebsiteDigest({
                  db: turso,
                  env,
                  summary: {
                    restaurantsChecked: cumulative.restaurants,
                    externalEntriesChecked: cumulative.externalEntries,
                    pagesChecked: cumulative.pages,
                    cardsChecked: null,
                    errors: (Array.isArray(cumulative.errors) ? cumulative.errors : []).map(issue => ({
                      name: issue.name || "Restaurant",
                      url: issue.url || "",
                      detail: issue.error || "Website-Prüfung fehlgeschlagen."
                    }))
                  }
                });
              } catch (emailError) {
                emailReport = { sent: false, reason: String(emailError?.message || emailError).slice(0, 500) };
                console.error("E-Mail nach manuellem Website-Prüflauf fehlgeschlagen:", emailReport.reason);
              }
              cumulative.email = emailReport;
              await turso(
                "UPDATE restaurant_website_monitor_runs SET report_json=? WHERE id=1 AND run_id=? AND status='completed'",
                [textArg(JSON.stringify(cumulative)), textArg(runId)]
              );
            }
            return json({
              success: true,
              processed: restaurant.name || restaurant.id,
              completed: cumulative.completed,
              total: claimedQueue.length,
              finished,
              emailSent: emailReport?.sent === true,
              emailReason: emailReport?.sent ? "" : (emailReport?.reason || "")
            });
          } catch (error) {
            const failed = { ...cumulative, phase: "failed", error: String(error?.message || error).slice(0, 400), activeRestaurants: [] };
            await turso(
              "UPDATE restaurant_website_monitor_runs SET status='failed', finished_at=?, report_json=?, batch_lock='', batch_lock_at='' WHERE id=1 AND run_id=? AND batch_lock=?",
              [textArg(new Date().toISOString()), textArg(JSON.stringify(failed)), textArg(runId), textArg(lockToken)]
            );
            console.error("Manueller Website-Prüfschritt fehlgeschlagen:", failed.error);
            return json({ success: false, error: failed.error }, 500);
          }
        }

        if (body.action === "getRestaurantWebsiteMonitorRun") {
          const result = await turso(
            "SELECT run_id, status, started_at, finished_at, report_json FROM restaurant_website_monitor_runs WHERE id = 1",
            [], true
          );
          const row = result?.results?.[0]?.response?.result?.rows?.[0];
          if (!row) return json({ success: true, run: null });
          let report = {};
          try { report = JSON.parse(String(rowValue(row[4]) || "{}")); } catch {}
          return json({ success: true, run: {
            runId: rowValue(row[0]), status: rowValue(row[1]), startedAt: rowValue(row[2]),
            finishedAt: rowValue(row[3]), report
          }});
        }

        if (body.action === "getRestaurantWebsiteMonitorCoverage") {
          const runResult = await turso(
            "SELECT status, started_at, finished_at FROM restaurant_website_monitor_runs WHERE id = 1",
            [], true
          );
          const runRow = runResult?.results?.[0]?.response?.result?.rows?.[0];
          if (!runRow) return json({ success: true, ready: false, status: "none" });
          const runStatus = String(rowValue(runRow[0]) || "");
          const startedAt = String(rowValue(runRow[1]) || "");
          const finishedAt = String(rowValue(runRow[2]) || "");
          if (runStatus !== "completed" || !startedAt || !finishedAt) {
            return json({ success: true, ready: false, status: runStatus });
          }
          const coverageResult = await turso(
            `SELECT r.id, r.name, r.website,
              (SELECT COUNT(*) FROM restaurant_site_snapshots s
               WHERE CAST(s.restaurant_id AS TEXT)=CAST(r.id AS TEXT) AND s.page_url=r.website
                 AND s.checked_at >= ? AND s.checked_at <= ?),
              r.externer_eintrag,
              (SELECT COUNT(*) FROM restaurant_site_snapshots s
               WHERE CAST(s.restaurant_id AS TEXT)=CAST(r.id AS TEXT) AND s.page_url=r.externer_eintrag
                 AND s.checked_at >= ? AND s.checked_at <= ?)
            FROM restaurants r
            WHERE TRIM(COALESCE(r.website, '')) <> '' OR TRIM(COALESCE(r.externer_eintrag, '')) <> ''
            ORDER BY r.name COLLATE NOCASE` ,
            [textArg(startedAt), textArg(finishedAt), textArg(startedAt), textArg(finishedAt)], true
          );
          const rows = coverageResult?.results?.[0]?.response?.result?.rows || [];
          const officialItems = rows.filter(row => String(rowValue(row[2]) || "").trim()).map(row => ({
            restaurantId:String(rowValue(row[0]) || ""), name:String(rowValue(row[1]) || ""),
            website:String(rowValue(row[2]) || ""), snapshotPages:Number(rowValue(row[3]) || 0)
          }));
          const externalItems = rows.filter(row => String(rowValue(row[4]) || "").trim()).map(row => ({
            restaurantId:String(rowValue(row[0]) || ""), name:String(rowValue(row[1]) || ""),
            website:String(rowValue(row[4]) || ""), snapshotPages:Number(rowValue(row[5]) || 0)
          }));
          const missing = officialItems.filter(item => item.snapshotPages === 0);
          const externalMissing = externalItems.filter(item => item.snapshotPages === 0);
          return json({
            success:true, ready:true, status:runStatus, startedAt, finishedAt,
            total:officialItems.length, covered:officialItems.length-missing.length, missing, items:officialItems,
            externalTotal:externalItems.length, externalCovered:externalItems.length-externalMissing.length,
            externalMissing, externalItems
          });
        }

        if (body.action === "getRestaurantWebsiteChanges") {
          await turso(`CREATE TABLE IF NOT EXISTS restaurant_change_proposals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            restaurant_id TEXT NOT NULL,
            field_name TEXT NOT NULL,
            old_value TEXT NOT NULL DEFAULT '',
            new_value TEXT NOT NULL DEFAULT '',
            source_url TEXT NOT NULL,
            detected_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'accepted', 'rejected')),
            reviewed_at TEXT NOT NULL DEFAULT '',
    notified_at TEXT NOT NULL DEFAULT '',
            UNIQUE (restaurant_id, field_name, old_value, new_value)
          )`);
          const result = await turso(`SELECT p.id, p.restaurant_id, r.name, p.field_name,
            p.old_value, p.new_value, p.source_url, p.detected_at, p.status
            FROM restaurant_change_proposals p
            LEFT JOIN restaurants r ON CAST(r.id AS TEXT) = p.restaurant_id
            WHERE p.status = 'pending'
              AND p.field_name IN ('telefon', 'email', 'website', 'adresse',
                'oeffnungszeiten', 'ruhetag', 'betriebsferien', 'dokumente', 'externe_links')
            ORDER BY p.detected_at DESC, p.id DESC
            LIMIT 250`, [], true);
          const rows = result?.results?.[0]?.response?.result?.rows || [];
          return json({ success: true, items: rows.map(row => ({
            id: rowValue(row[0]), restaurantId: rowValue(row[1]), restaurantName: rowValue(row[2]),
            field: rowValue(row[3]), oldValue: rowValue(row[4]), newValue: rowValue(row[5]),
            sourceUrl: rowValue(row[6]), detectedAt: rowValue(row[7]), status: rowValue(row[8])
          })) });
        }

        if (body.action === "reviewRestaurantWebsiteChange") {
          const id = Number(body.id);
          const status = String(body.status || "");
          if (!Number.isSafeInteger(id) || id < 1 || !["accepted", "rejected"].includes(status)) {
            return json({ error: "Änderungs-ID oder Status ist ungültig." }, 400);
          }
          const reviewedAt = new Date().toISOString();
          await turso(
            "UPDATE restaurant_change_proposals SET status = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'",
            [textArg(status), textArg(reviewedAt), integerArg(id)]
          );
          return json({ success: true, id, status, reviewedAt });
        }

        if (body.action === "saveTitleText") {
          const title = String(body.title || "").trim().slice(0, 120);
          const subtitle = String(body.subtitle || "").trim().slice(0, 240);
          if (!title || !subtitle) return json({ error: "Überschrift und Untertitel dürfen nicht leer sein." }, 400);
          try {
            const updatedAt = new Date().toISOString();
            await turso(
              "INSERT INTO title_text_settings (id,title,subtitle,updated_at) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,subtitle=excluded.subtitle,updated_at=excluded.updated_at",
              [textArg(title), textArg(subtitle), textArg(updatedAt)]
            );
            const verify = await turso("SELECT title, subtitle FROM title_text_settings WHERE id = 1", [], true);
            const row = verify?.results?.[0]?.response?.result?.rows?.[0];
            const savedTitle = row ? String(rowValue(row[0]) || "") : "";
            const savedSubtitle = row ? String(rowValue(row[1]) || "") : "";
            if (savedTitle !== title || savedSubtitle !== subtitle) {
              return json({ error: "Die Datenbank hat die Textänderung nicht korrekt bestätigt." }, 500);
            }
            return json({ success: true, verified: true, title: savedTitle, subtitle: savedSubtitle });
          } catch (error) {
            console.error("Title text save failed", String(error?.message || error).slice(0, 300));
            return json({ error: "Titeltext konnte nicht gespeichert werden: " + String(error?.message || error).slice(0, 180) }, 500);
          }
        }

        if (body.action === "uploadTitleImage") {
          const filename=String(body.filename || "titelbild.webp").replace(/[\\r\\n"\\\\]/g,"_").slice(0,120);
          const mimeType=String(body.mimeType || "");
          const base64=String(body.base64 || "");
          if (!["image/webp","image/jpeg","image/png"].includes(mimeType) || !base64) return json({error:"Bitte ein gültiges JPG-, PNG- oder WebP-Bild auswählen."},400);
          if (base64.length > 7100000) return json({error:"Das Titelbild darf höchstens 5 MB groß sein."},413);
          let binary;
          try { binary=atob(base64); } catch { return json({error:"Das Bild ist ungültig kodiert."},400); }
          if (binary.length < 12 || binary.length > 5*1024*1024) return json({error:"Das Titelbild darf höchstens 5 MB groß sein."},413);
          const isJpeg=binary.charCodeAt(0)===255 && binary.charCodeAt(1)===216 && binary.charCodeAt(2)===255;
          const isPng=binary.slice(0,8)===String.fromCharCode(137,80,78,71,13,10,26,10);
          const isWebp=binary.slice(0,4)==="RIFF" && binary.slice(8,12)==="WEBP";
          if (!((mimeType==="image/jpeg"&&isJpeg)||(mimeType==="image/png"&&isPng)||(mimeType==="image/webp"&&isWebp))) return json({error:"Dateiformat und Bildinhalt stimmen nicht überein."},400);
          try {
            const updatedAt=new Date().toISOString();
            await turso("INSERT INTO title_image_settings (id,filename,mime_type,file_data,updated_at) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET filename=excluded.filename,mime_type=excluded.mime_type,file_data=excluded.file_data,updated_at=excluded.updated_at",
              [textArg(filename),textArg(mimeType),{type:"blob",base64:base64},textArg(updatedAt)]);
            const verify=await turso("SELECT filename,mime_type,length(file_data) FROM title_image_settings WHERE id=1",[],true);
            const row=verify?.results?.[0]?.response?.result?.rows?.[0];
            const savedName=row?String(rowValue(row[0])||""):"";
            const savedMime=row?String(rowValue(row[1])||""):"";
            const savedBytes=row?Number(rowValue(row[2])||0):0;
            if (!row || savedName!==filename || savedMime!==mimeType || savedBytes!==binary.length) return json({error:"Die Datenbank hat das Titelbild nicht korrekt bestätigt."},500);
            return json({success:true,verified:true,bytes:savedBytes});
          } catch(error) {
            console.error("Title image upload failed",String(error?.message||error).slice(0,300));
            return json({error:"Titelbild-Speicherfehler: "+String(error?.message||error).slice(0,200)},500);
          }
        }

        if (body.action === "uploadGalleryImage") {
          const restaurantId=String(body.restaurantId||"").trim();
          const filename=String(body.filename||"bild.webp").trim().slice(0,120);
          const caption=String(body.caption||"").trim().slice(0,300);
          const base64=String(body.base64||"");
          if(!restaurantId||!base64) return json({error:"Restaurant oder Bild fehlt."},400);
          if(base64.length>1_450_000) return json({error:"Ein Galeriebild darf höchstens 1 MB groß sein."},413);
          let binary; try{binary=atob(base64)}catch{return json({error:"Bild ist ungültig kodiert."},400)}
          if(binary.length<16||binary.length>1024*1024) return json({error:"Ein Galeriebild darf höchstens 1 MB groß sein."},413);
          if(!(binary.slice(0,4)==="RIFF"&&binary.slice(8,12)==="WEBP")) return json({error:"Bitte ein gültiges WebP-Bild auswählen."},400);
          const exists=await turso("SELECT id FROM restaurants WHERE CAST(id AS TEXT)=?",[textArg(restaurantId)],true);
          if(!(exists?.results?.[0]?.response?.result?.rows||[]).length) return json({error:"Restaurant nicht gefunden."},404);
          const countResult=await turso("SELECT COUNT(*) FROM restaurant_gallery_images WHERE restaurant_id=?",[textArg(restaurantId)],true);
          const count=Number(rowValue(countResult?.results?.[0]?.response?.result?.rows?.[0]?.[0])||0);
          if(count>=20) return json({error:"Pro Restaurant sind höchstens 20 zusätzliche Bilder möglich."},409);
          const updatedAt=new Date().toISOString();
          await turso("INSERT INTO restaurant_gallery_images (restaurant_id,filename,mime_type,file_data,sort_order,updated_at,caption) VALUES (?,?, 'image/webp', ?, ?, ?, ?)",[textArg(restaurantId),textArg(filename),{type:"blob",base64},integerArg(count),textArg(updatedAt),textArg(caption)]);
          const verify=await turso("SELECT id, length(file_data) FROM restaurant_gallery_images WHERE restaurant_id=? AND filename=? ORDER BY id DESC LIMIT 1",[textArg(restaurantId),textArg(filename)],true);
          const row=verify?.results?.[0]?.response?.result?.rows?.[0];
          const savedBytes=row?Number(rowValue(row[1])||0):0;
          if(!row||savedBytes!==binary.length) return json({error:"Speicherung konnte nicht bestätigt werden."},500);
          return json({success:true,id:rowValue(row[0]),bytes:savedBytes,verified:true});
        }

        if (body.action === "reorderGalleryImages") {
          const restaurantId=String(body.restaurantId||"").trim();
          const imageIds=Array.isArray(body.imageIds)?body.imageIds.map(Number):[];
          if(!restaurantId||imageIds.length>20||imageIds.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(imageIds).size!==imageIds.length) {
            return json({error:"Die Bildreihenfolge ist ungültig."},400);
          }
          const existing=await turso("SELECT id FROM restaurant_gallery_images WHERE restaurant_id=? ORDER BY sort_order,id",[textArg(restaurantId)],true);
          const rows=existing?.results?.[0]?.response?.result?.rows||[];
          const existingIds=rows.map(row=>Number(rowValue(row[0])));
          if(existingIds.length!==imageIds.length||existingIds.some(id=>!imageIds.includes(id))) {
            return json({error:"Die Galerie wurde zwischenzeitlich geändert. Bitte erneut laden."},409);
          }
          const updatedAt=new Date().toISOString();
          for(let index=0;index<imageIds.length;index++){
            await turso("UPDATE restaurant_gallery_images SET sort_order=?,updated_at=? WHERE restaurant_id=? AND id=?",[integerArg(index),textArg(updatedAt),textArg(restaurantId),integerArg(imageIds[index])]);
          }
          const verify=await turso("SELECT id FROM restaurant_gallery_images WHERE restaurant_id=? ORDER BY sort_order,id",[textArg(restaurantId)],true);
          const savedIds=(verify?.results?.[0]?.response?.result?.rows||[]).map(row=>Number(rowValue(row[0])));
          if(savedIds.length!==imageIds.length||savedIds.some((id,index)=>id!==imageIds[index])) {
            return json({error:"Die gespeicherte Bildreihenfolge konnte nicht bestätigt werden."},500);
          }
          return json({success:true,verified:true,imageIds:savedIds});
        }

        if (body.action === "updateGalleryCaption") {
          const restaurantId=String(body.restaurantId||"").trim(), imageId=Number(body.imageId||0);
          const caption=String(body.caption||"").trim().slice(0,300);
          if(!restaurantId||!Number.isSafeInteger(imageId)||imageId<1) return json({error:"Bildangabe ungültig."},400);
          const found=await turso("SELECT id FROM restaurant_gallery_images WHERE restaurant_id=? AND id=?",[textArg(restaurantId),integerArg(imageId)],true);
          if(!(found?.results?.[0]?.response?.result?.rows||[]).length) return json({error:"Bild nicht gefunden."},404);
          await turso("UPDATE restaurant_gallery_images SET caption=?, updated_at=? WHERE restaurant_id=? AND id=?",[textArg(caption),textArg(new Date().toISOString()),textArg(restaurantId),integerArg(imageId)]);
          const verify=await turso("SELECT caption FROM restaurant_gallery_images WHERE restaurant_id=? AND id=?",[textArg(restaurantId),integerArg(imageId)],true);
          const saved=String(rowValue(verify?.results?.[0]?.response?.result?.rows?.[0]?.[0])||"");
          if(saved!==caption) return json({error:"Beschriftung konnte nicht bestätigt werden."},500);
          return json({success:true,verified:true,caption:saved});
        }

        if (body.action === "deleteGalleryImage") {
          const restaurantId=String(body.restaurantId||"").trim(), imageId=Number(body.imageId||0);
          if(!restaurantId||!Number.isSafeInteger(imageId)||imageId<1) return json({error:"Bildangabe ungültig."},400);
          const found=await turso("SELECT id FROM restaurant_gallery_images WHERE restaurant_id=? AND id=?",[textArg(restaurantId),integerArg(imageId)],true);
          if(!(found?.results?.[0]?.response?.result?.rows||[]).length) return json({error:"Bild nicht gefunden."},404);
          await turso("DELETE FROM restaurant_gallery_images WHERE restaurant_id=? AND id=?",[textArg(restaurantId),integerArg(imageId)]);
          const verify=await turso("SELECT id FROM restaurant_gallery_images WHERE restaurant_id=? AND id=?",[textArg(restaurantId),integerArg(imageId)],true);
          if((verify?.results?.[0]?.response?.result?.rows||[]).length) return json({error:"Löschen konnte nicht bestätigt werden."},500);
          return json({success:true,deleted:true});
        }

        if (body.action === "uploadCardFile") {
          const restaurantId=String(body.restaurantId||"").trim(), kind=String(body.kind||"").trim();
          const filename=String(body.filename||"").trim().slice(0,120), base64=String(body.base64||"");
          if(!restaurantId||!["speisekarte","getraenkekarte","dessertkarte","brotzeitkarte","saisonkarte"].includes(kind)) return json({error:"Restaurant oder Kartenart ist ungültig."},400);
          if(!filename.toLowerCase().endsWith(".pdf")||!base64) return json({error:"Bitte eine gültige PDF-Datei auswählen."},400);
          if(base64.length>9_600_000) return json({error:"Die PDF-Datei darf höchstens 7 MB groß sein."},413);
          let binary; try{binary=atob(base64)}catch{return json({error:"Die PDF-Datei ist ungültig kodiert."},400)}
          const pdfLimit=["dessertkarte","brotzeitkarte","saisonkarte"].includes(kind)?4*1024*1024:7*1024*1024;
          if(binary.length>pdfLimit) return json({error:"Die PDF-Datei darf höchstens "+(pdfLimit/1024/1024)+" MB groß sein."},413);
          if(binary.length<5||binary.slice(0,5)!=="%PDF-") return json({error:"Die Datei scheint keine gültige PDF-Datei zu sein."},400);
          try {
            // Ensure the metadata row exists too: the cards endpoint starts from restaurant_cards
            // and joins the PDF table. Preserve any existing official URL on conflict.
            await turso(
              `INSERT INTO restaurant_cards (restaurant_id, kind, url, updated_at)
               VALUES (?, ?, '', ?)
               ON CONFLICT(restaurant_id, kind) DO NOTHING`,
              [textArg(restaurantId), textArg(kind), textArg(new Date().toISOString())]
            );
            await turso(`INSERT INTO restaurant_card_files (restaurant_id,kind,filename,mime_type,file_data,updated_at) VALUES (?, ?, ?, 'application/pdf', ?, ?) ON CONFLICT(restaurant_id,kind) DO UPDATE SET filename=excluded.filename,mime_type=excluded.mime_type,file_data=excluded.file_data,updated_at=excluded.updated_at`,[textArg(restaurantId),textArg(kind),textArg(filename),{type:"blob",base64:base64},textArg(new Date().toISOString())]);
            const verify = await turso("SELECT filename, length(file_data) FROM restaurant_card_files WHERE restaurant_id = ? AND kind = ?",[textArg(restaurantId),textArg(kind)],true);
            const row = verify?.results?.[0]?.response?.result?.rows?.[0];
            const savedName = row ? String(rowValue(row[0]) || "") : "";
            const savedBytes = row ? Number(rowValue(row[1]) || 0) : 0;
            if (!row || savedName !== filename || savedBytes !== binary.length) {
              console.error("PDF upload verification failed", {restaurantId, kind, filename, expectedBytes:binary.length, savedName, savedBytes});
              return json({error:"Die Datenbank hat den PDF-Upload nicht korrekt bestätigt. Bitte erneut versuchen."},500);
            }
            return json({success:true,action:"uploadCardFile",bytes:savedBytes,filename:savedName,verified:true});
          } catch (uploadError) {
            console.error("PDF upload failed", {restaurantId, kind, filename, error:String(uploadError?.message || uploadError).slice(0,300)});
            return json({error:"PDF-Speicherfehler: "+String(uploadError?.message || uploadError).slice(0,220)},500);
          }
        }

        if (body.action === "deleteCardFile") {
          const restaurantId = String(body.restaurantId || "").trim();
          const kind = String(body.kind || "").trim();
          if (!restaurantId || !["speisekarte", "getraenkekarte", "dessertkarte", "brotzeitkarte", "saisonkarte"].includes(kind)) {
            return json({ error: "Restaurant oder Kartenart ist ungültig." }, 400);
          }
          const existing = await turso(
            "SELECT filename FROM restaurant_card_files WHERE restaurant_id = ? AND kind = ?",
            [textArg(restaurantId), textArg(kind)], true
          );
          const row = existing?.results?.[0]?.response?.result?.rows?.[0];
          if (!row) return json({ error: "Für diese Kartenart ist keine PDF gespeichert." }, 404);
          await turso(
            "DELETE FROM restaurant_card_files WHERE restaurant_id = ? AND kind = ?",
            [textArg(restaurantId), textArg(kind)]
          );
          const verify = await turso(
            "SELECT filename FROM restaurant_card_files WHERE restaurant_id = ? AND kind = ?",
            [textArg(restaurantId), textArg(kind)], true
          );
          const remaining = verify?.results?.[0]?.response?.result?.rows?.[0];
          if (remaining) return json({ error: "Die PDF wurde nicht vollständig gelöscht. Bitte erneut versuchen." }, 500);
          return json({ success: true, action: "deleteCardFile", restaurantId, kind });
        }

        if (body.action === "saveCard") {
          const restaurantId = String(body.restaurantId || "").trim();
          const kind = String(body.kind || "").trim();
          const cardUrl = String(body.url || "").trim();
          if (!restaurantId || !["speisekarte", "getraenkekarte", "dessertkarte", "brotzeitkarte", "saisonkarte"].includes(kind)) {
            return json({ error: "Restaurant oder Kartenart ist ungültig." }, 400);
          }
          if (cardUrl && !/^https?:\/\//i.test(cardUrl)) {
            return json({ error: "Bitte einen gültigen http(s)-Link eingeben." }, 400);
          }
          await turso(
            `INSERT INTO restaurant_cards (restaurant_id, kind, url, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(restaurant_id, kind) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`,
            [textArg(restaurantId), textArg(kind), textArg(cardUrl), textArg(new Date().toISOString())]
          );
          return json({ success: true, action: "saveCard" });
        }

        if (body.action === "create") {
          const r = body.restaurant || {};
          if (!String(r.name || "").trim()) {
            return json({ error: "Name ist erforderlich" }, 400);
          }

          const result = await turso(
            `INSERT INTO restaurants (
              name, ort, kategorie, adresse, telefon, website, email,
              oeffnungszeiten, ruhetag, betriebsferien_start, betriebsferien_ende, notizen, bild, reservierung, externer_eintrag, zahlungsarten, zahlungsarten_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              textArg(r.name), textArg(r.ort), textArg(r.kategorie),
              textArg(r.adresse), textArg(r.telefon), textArg(r.website),
              textArg(r.email), textArg(r.oeffnungszeiten),
              textArg(r.ruhetag), textArg(r.betriebsferien_start), textArg(r.betriebsferien_ende),
              textArg(r.notizen), textArg(r.bild), textArg(r.reservierung), textArg(r.externer_eintrag),
              textArg(JSON.stringify(Array.isArray(r.zahlungsarten) ? r.zahlungsarten.filter(item => ["girocard", "debitkarte", "kreditkarte"].includes(item)) : [])),
              textArg(["red","yellow","green"].includes(r.zahlungsarten_status) ? r.zahlungsarten_status : "")
            ]
          );

          return json({ success: true, action: "create", result });
        }

        if (body.action === "update") {
          const r = body.restaurant || {};

          if (body.id == null || body.id === "") {
            return json({ error: "ID fehlt" }, 400);
          }
          if (!String(r.name || "").trim()) {
            return json({ error: "Name ist erforderlich" }, 400);
          }

          const result = await turso(
            `UPDATE restaurants SET
              name = ?, ort = ?, kategorie = ?, adresse = ?,
              telefon = ?, website = ?, email = ?, oeffnungszeiten = ?,
              ruhetag = ?, betriebsferien_start = ?, betriebsferien_ende = ?,
              notizen = ?, bild = ?, reservierung = ?, externer_eintrag = ?, zahlungsarten = ?, zahlungsarten_status = ?
            WHERE id = ?`,
            [
              textArg(r.name), textArg(r.ort), textArg(r.kategorie),
              textArg(r.adresse), textArg(r.telefon), textArg(r.website),
              textArg(r.email), textArg(r.oeffnungszeiten),
              textArg(r.ruhetag), textArg(r.betriebsferien_start), textArg(r.betriebsferien_ende),
              textArg(r.notizen), textArg(r.bild), textArg(r.reservierung), textArg(r.externer_eintrag),
              textArg(JSON.stringify(Array.isArray(r.zahlungsarten) ? r.zahlungsarten.filter(item => ["girocard", "debitkarte", "kreditkarte"].includes(item)) : [])),
              textArg(["red","yellow","green"].includes(r.zahlungsarten_status) ? r.zahlungsarten_status : ""),
              integerArg(body.id)
            ]
          );

          // Nach dem UPDATE den gespeicherten Wert direkt aus Turso zurücklesen.
          // So melden wir keinen Erfolg, wenn der externe Link nicht dauerhaft angekommen ist.
          const verification = await turso(
            "SELECT externer_eintrag, zahlungsarten FROM restaurants WHERE id = ?",
            [integerArg(body.id)],
            true
          );
          const verifiedRows = verification?.results?.[0]?.response?.result?.rows || [];
          const storedExternalEntry = String(rowValue(verifiedRows?.[0]?.[0]) || "").trim();
          const expectedExternalEntry = String(r.externer_eintrag || "").trim();
          let storedPaymentTypes = [];
          try {
            const parsed = JSON.parse(String(rowValue(verifiedRows?.[0]?.[1]) || "[]"));
            if (Array.isArray(parsed)) storedPaymentTypes = parsed.filter(item => ["girocard", "debitkarte", "kreditkarte"].includes(item));
          } catch {}
          const expectedPaymentTypes = Array.isArray(r.zahlungsarten)
            ? r.zahlungsarten.filter(item => ["girocard", "debitkarte", "kreditkarte"].includes(item))
            : [];
          const paymentTypesMatch = JSON.stringify([...storedPaymentTypes].sort()) === JSON.stringify([...expectedPaymentTypes].sort());
          if (verifiedRows.length === 0 || storedExternalEntry !== expectedExternalEntry || !paymentTypesMatch) {
            return json({
              error: !paymentTypesMatch
                ? "Die Zahlungsarten konnten nicht dauerhaft gespeichert und bestätigt werden. Bitte erneut versuchen."
                : "Der externe Eintrag konnte nicht dauerhaft gespeichert und bestätigt werden. Bitte erneut versuchen.",
              verified: false,
              paymentTypesVerified: paymentTypesMatch
            }, 500);
          }

          return json({ success: true, action: "update", verified: true, paymentTypesVerified: true, result });
        }

        if (body.action === "delete") {
          if (body.id == null || body.id === "") {
            return json({ error: "ID fehlt" }, 400);
          }

          const result = await turso(
            "DELETE FROM restaurants WHERE id = ?",
            [integerArg(body.id)]
          );

          return json({ success: true, action: "delete", result });
        }

        return json({ error: "Unbekannte Aktion" }, 400);
      }

      return json({ error: "Methode nicht erlaubt" }, 405);
    } catch (error) {
      return json({
        error: "Serverfehler",
        message: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    return runScheduledRestaurantMonitoring(env, ctx);
  }
};
