export default {
  async fetch(request, env) {
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

      const data = await response.json();

      if (!response.ok) {
        throw new Error(`Turso HTTP-Fehler (${response.status})`);
      }

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

    function textArg(value) {
      return { type: "text", value: value == null ? "" : String(value) };
    }

    function integerArg(value) {
      return { type: "integer", value: String(value) };
    }

    function rowValue(value) {
      if (value == null) return "";
      if (typeof value === "object" && "value" in value) return value.value;
      return value;
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

      function hasRestaurantNameInHost(url) {
        try {
          const host = normalize(new URL(url).hostname.replace(/^www\./i, ""));
          if (!nameTokens.length) return false;
          const hostParts = host.split(/\s+/).filter(Boolean);
          return nameTokens.every(token => {
            return hostParts.some(part =>
              part === token || (token.length >= 5 && part.startsWith(token))
            );
          });
        } catch {
          return false;
        }
      }

      function isTrustedRegionalSource(url) {
        try {
          const host = new URL(url).hostname.toLowerCase().replace(/^www\./i, "");
          return host === "tegernsee.com" || host.endsWith(".tegernsee.com");
        } catch {
          return false;
        }
      }

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
        // Alle markanten Bestandteile des Restaurantnamens müssen im Seitentitel
        // oder in der Domain vorkommen. Ein einzelnes gemeinsames Wort genügt
        // nicht mehr, da sonst ähnlich benannte Betriebe durchrutschen können.
        const titleAndHost = (title + " " + host).split(/\s+/).filter(Boolean);
        if (!nameTokens.length) return false;
        return nameTokens.every(token =>
          titleAndHost.some(part =>
            part === token || (token.length >= 5 && part.startsWith(token))
          )
        );
      }

      const relevant = results.filter(result =>
        hasStrongNameMatch(result) && hasLocalEvidence(result)
      );

      if (!relevant.length) return [];

      // Eigene Restaurant-Webseiten bevorzugen.
      relevant.sort((a, b) => {
        function score(result) {
          if (!result.url) return 0;

          // Offizielle regionale Gastgeberprofile enthalten häufig die
          // verlässlichsten Anschrift- und Öffnungszeitenangaben. Diese Quelle
          // muss auch vor allgemeinen Verzeichnissen extrahiert werden.
          if (isTrustedRegionalSource(result.url)) return 25;
          if (isDirectory(result.url)) return 0;

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
            (isDirectory(result.url) && !isTrustedRegionalSource(result.url)) ||
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
          .replace(/<\/(?:p|div|li|tr|h[1-6]|address|section)\s*>/gi, "\n")
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;|&#160;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/&quot;|&#34;/gi, '"')
          .replace(/&#39;|&apos;/gi, "'")
          .replace(/[ \t]+/g, " ");

        const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const streetPattern =
          /\b(?:[A-ZÄÖÜ][\p{L}.'-]*(?:straße|strasse|str\.?|weg|platz|gasse|allee|ufer|ring|chaussee|damm|steig)|[A-ZÄÖÜ][\p{L}.'-]*(?:[ \t]+[\p{L}.'-]+){0,4}[ \t]+(?:straße|strasse|str\.?|weg|platz|gasse|allee|ufer|ring|chaussee|damm|steig))[ \t]+\d+[a-z]?(?:\s*[-–—/]\s*\d+[a-z]?)?\b/iu;

        // Ortslagen wie „Enterrottach 1“ sind gültige Anschriften am Tegernsee,
        // obwohl sie nicht auf Straße/Weg/Platz enden. Nur bekannte lokale
        // Anschriftenformen werden zusätzlich akzeptiert.
        const localAddressPattern =
          /\b(?:Enterrottach|Sutten|Valepp|Wildbad Kreuth|Siebenhütten|Monialm|Wallbergstraße|Wallbergstr\.?)\s+\d+[a-z]?(?:\s*[-–—/]\s*\d+[a-z]?)?\b/iu;
        const postalPattern = /\b(?:83700|83703|83707|83708|83727|83730|83734|83684)\s+[A-ZÄÖÜ][\p{L}-]+/iu;
        const addressLabel = /(?:adresse|anschrift|standort|anfahrt|besuchen sie uns|hier finden sie uns)/i;

        // Beschriftete Adresszeilen haben Vorrang vor zufälligen Straßenangaben
        // in Texten, Veranstaltungen oder verlinkten Fremdseiten.
        const orderedLines = [
          ...lines.filter(line => addressLabel.test(line)),
          ...lines.filter(line => postalPattern.test(line)),
          ...lines
        ];
        const seen = new Set();
        for (const line of orderedLines) {
          if (seen.has(line)) continue;
          seen.add(line);
          const match = line.match(streetPattern) || line.match(localAddressPattern);
          if (!match) continue;
          const after = line.slice((match.index || 0) + match[0].length);
          const postal = after.match(
            /^\s*[,;]?\s*(\d{5}\s+[A-ZÄÖÜ][\p{L}-]+)/iu
          );
          return (
            match[0].replace(/\s*[-–—/]\s*/g, "–") +
            (postal ? ", " + postal[1] : "")
          ).replace(/\s+/g, " ").trim().slice(0, 180);
        }
        return "";
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

        const fullDays = [
          ["Montag", "Mo(?:ntag)?"],
          ["Dienstag", "Di(?:enstag)?"],
          ["Mittwoch", "Mi(?:ttwoch)?"],
          ["Donnerstag", "Do(?:nnerstag)?"],
          ["Freitag", "Fr(?:eitag)?"],
          ["Samstag", "Sa(?:mstag)?"],
          ["Sonntag", "So(?:nntag)?"]
        ];
        const dayPattern = fullDays.map(item => item[1]).join("|");
        const separator = "(?:\\s*(?:,|;|und|&|/)\\s*)";

        // Erst explizit als Ruhetage markierte Angaben auswerten und mehrere
        // aufeinanderfolgende Wochentage erfassen (z. B. Mo/Di sowie Sa/So).
        const ruhetagBefore = value.match(new RegExp(
          "\\b((?:" + dayPattern + ")(?:" + separator + "(?:" + dayPattern + ")){0,6})\\s*(?:sind\\s*)?Ruhetag(?:e)?\\b", "i"
        ));
        const ruhetagAfter = value.match(new RegExp(
          "\\bRuhetag(?:e)?\\s*[:：]?\\s*((?:" + dayPattern + ")(?:" + separator + "(?:" + dayPattern + ")){0,6})\\b", "i"
        ));
        const explicit = ruhetagBefore || ruhetagAfter;
        if (explicit) {
          const found = [];
          for (const token of explicit[1].match(new RegExp(dayPattern, "gi")) || []) {
            const item = fullDays.find(day => new RegExp("^" + day[1] + "$", "i").test(token));
            if (item && !found.includes(item[0])) found.push(item[0]);
          }
          if (found.length) return found.join(", ");
        }

        // Explizit geschlossene Tage ohne das Wort Ruhetag erkennen.
        const closed = value.match(new RegExp(
          "\\b((?:" + dayPattern + ")(?:" + separator + "(?:" + dayPattern + ")){0,6})\\s*(?:sind|ist)?\\s*(?:geschlossen|Betriebsferien)\\b", "i"
        ));
        if (closed) {
          const found = [];
          for (const token of closed[1].match(new RegExp(dayPattern, "gi")) || []) {
            const item = fullDays.find(day => new RegExp("^" + day[1] + "$", "i").test(token));
            if (item && !found.includes(item[0])) found.push(item[0]);
          }
          if (found.length) return found.join(", ");
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
          email: (hasRestaurantNameInHost(url) || isTrustedRegionalSource(url))
            ? extractEmail(extracted)
            : "",
          kategorie: extractCategory(
            String(result.title || "") + "\n" + content
          ),
          oeffnungszeiten: hours.opening,
          kuechenzeiten: hours.kitchen,
          ruhetag: extractClosedDay(content),
          website: url && !isDirectory(url) && hasRestaurantNameInHost(url) ? url : ""
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
          email: (hasRestaurantNameInHost(page.url) || isTrustedRegionalSource(page.url))
            ? extractEmail(page.content)
            : "",
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

      if (request.method === "GET") {
        const url = new URL(request.url);
        const action = url.searchParams.get("action");

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
            PRIMARY KEY (restaurant_id, kind)
          )`);
          const restaurantId = (url.searchParams.get("restaurantId") || "").trim();
          if (!restaurantId) return json({ error: "Restaurant-ID fehlt." }, 400);
          const result = await turso(
            `SELECT c.kind, c.url, q.checked_at, q.changed_at, q.status, q.detail, q.url
             FROM restaurant_cards c
             LEFT JOIN restaurant_card_checks q
               ON q.restaurant_id = c.restaurant_id AND q.kind = c.kind
             WHERE c.restaurant_id = ?`,
            [textArg(restaurantId)], true
          );
          const rows = result?.results?.[0]?.response?.result?.rows || [];
          const cards = {};
          for (const row of rows) {
            const kind = String(rowValue(row[0]) || "");
            if (!["speisekarte", "getraenkekarte"].includes(kind)) continue;
            const cardUrl = rowValue(row[1]) || "";
            const checkedUrl = rowValue(row[6]) || "";
            cards[kind] = {
              url: cardUrl,
              checkedAt: checkedUrl === cardUrl ? (rowValue(row[2]) || "") : "",
              changedAt: checkedUrl === cardUrl ? (rowValue(row[3]) || "") : "",
              checkStatus: checkedUrl === cardUrl ? (rowValue(row[4]) || "") : "",
              checkDetail: checkedUrl === cardUrl ? (rowValue(row[5]) || "") : ""
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
            id, name, ort, kategorie, adresse, telefon, website,
            email, oeffnungszeiten, ruhetag, notizen, bild, reservierung
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
          email: rowValue(row[7]),
          oeffnungszeiten: rowValue(row[8]),
          ruhetag: rowValue(row[9]),
          notizen: rowValue(row[10]),
          bild: rowValue(row[11]),
          reservierung: rowValue(row[12])
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

        if (body.action === "saveCard") {
          const restaurantId = String(body.restaurantId || "").trim();
          const kind = String(body.kind || "").trim();
          const cardUrl = String(body.url || "").trim();
          if (!restaurantId || !["speisekarte", "getraenkekarte"].includes(kind)) {
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
              oeffnungszeiten, ruhetag, notizen, bild, reservierung
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              textArg(r.name), textArg(r.ort), textArg(r.kategorie),
              textArg(r.adresse), textArg(r.telefon), textArg(r.website),
              textArg(r.email), textArg(r.oeffnungszeiten),
              textArg(r.ruhetag), textArg(r.notizen), textArg(r.bild),
              textArg(r.reservierung)
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
              ruhetag = ?, notizen = ?, bild = ?, reservierung = ?
            WHERE id = ?`,
            [
              textArg(r.name), textArg(r.ort), textArg(r.kategorie),
              textArg(r.adresse), textArg(r.telefon), textArg(r.website),
              textArg(r.email), textArg(r.oeffnungszeiten),
              textArg(r.ruhetag), textArg(r.notizen), textArg(r.bild),
              textArg(r.reservierung), integerArg(body.id)
            ]
          );

          return json({ success: true, action: "update", result });
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
    if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
      console.error("Kartenprüfung: Turso-Konfiguration fehlt.");
      return;
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
      detail TEXT NOT NULL DEFAULT '', PRIMARY KEY (restaurant_id, kind)
    )`);
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
      if (hash && oldUrl === item.url && oldHash === hash) status = "unchanged";
      if (hash && (!oldHash || oldUrl !== item.url)) status = "baseline";
      await db(`INSERT INTO restaurant_card_checks
        (restaurant_id, kind, url, checked_at, changed_at, content_hash, status, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(restaurant_id, kind) DO UPDATE SET
          url=excluded.url, checked_at=excluded.checked_at, changed_at=excluded.changed_at,
          content_hash=CASE WHEN excluded.content_hash <> '' THEN excluded.content_hash
            WHEN restaurant_card_checks.url = excluded.url THEN restaurant_card_checks.content_hash ELSE '' END,
          status=excluded.status, detail=excluded.detail`,
        [arg(item.restaurantId), arg(item.kind), arg(item.url), arg(now), arg(changedAt), arg(hash), arg(status), arg(detail)]
      );
    }
    for (let i = 0; i < entries.length; i += 5) {
      await Promise.all(entries.slice(i, i + 5).map(check));
    }
    console.log(`Kartenprüfung abgeschlossen: ${entries.length} offizielle Kartenlinks geprüft.`);
  }
};
