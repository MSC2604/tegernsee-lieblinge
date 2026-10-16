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
        }
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          `Tavily Usage HTTP-Fehler (${response.status}).`
        );
      }

      const key = data.key || {};
      const account = data.account || {};

      // Zuerst die Werte des API-Schlüssels verwenden.
      // Wenn dort kein Limit vorhanden ist, das Kontolimit prüfen.
      const used = Number.isFinite(Number(key.usage))
        ? Number(key.usage)
        : Number(account.plan_usage);

      let limit = key.limit;

      if (limit == null) {
        limit = account.plan_limit;
      }

      const validUsed = Number.isFinite(used) ? used : null;
      const validLimit =
        limit != null && Number.isFinite(Number(limit))
          ? Number(limit)
          : null;

      return {
        available: validUsed !== null && validLimit !== null,
        plan: account.current_plan || "Laut Tavily-Konto",
        used: validUsed,
        limit: validLimit,
        remaining:
          validUsed !== null && validLimit !== null
            ? Math.max(0, validLimit - validUsed)
            : null,
        searchUsage: key.search_usage ?? null,
        extractUsage: key.extract_usage ?? null,
        crawlUsage: key.crawl_usage ?? null,
        mapUsage: key.map_usage ?? null,
        note: validLimit === null
          ? "Tavily hat für diesen Schlüssel kein auswertbares Limit geliefert."
          : "Aktuelle Werte direkt von Tavily."
      };
    }

    // --------------------------------------------------
    // RESTAURANTSUCHE
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

      const tavilyHeaders = {
        Authorization: `Bearer ${env.TAVILY_API_KEY}`,
        "Content-Type": "application/json"
      };

      // 1. Kostengünstige Basissuche
      const searchResponse = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: tavilyHeaders,
        body: JSON.stringify({
          query:
            `"${cleanName}" Tegernseer Tal Restaurant Adresse Telefon ` +
            "offizielle Website Öffnungszeiten Ruhetag Speisekarte",
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
      const results = Array.isArray(searchData.results)
        ? searchData.results
        : [];

      function normalize(value) {
        return String(value || "")
          .toLocaleLowerCase("de")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
      }

      const normalizedName = normalize(cleanName);
      const nameTokens = normalizedName
        .split(/\s+/)
        .filter(token =>
          token.length > 2 &&
          ![
            "der", "die", "das", "zum", "zur", "am", "im",
            "gasthof", "restaurant", "wirtshaus"
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

      // Treffer nach markanten Namensbestandteilen filtern.
      const relevant = results.filter(result => {
        const title = normalize(result.title);
        const content = normalize(result.content);
        return nameTokens.some(token =>
          title.includes(token) || content.includes(token)
        );
      });

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
        const value = String(text || "").replace(/<[^>]*>/g, " ");
        const streetPattern =
          /\b[A-ZÄÖÜ][\p{L}.'-]*(?:[ \t]+[\p{L}.'-]+){0,3}[ \t]+(?:straße|strasse|str\.|weg|platz|gasse|allee|ufer|ring)[ \t]+\d+[a-z]?\b/iu;

        const match = value.match(streetPattern);
        if (!match) return "";

        const after = value.slice(match.index + match[0].length);
        const postal = after.match(
          /^\s*[,;\n-]?\s*(\d{5}\s+[A-ZÄÖÜ][\p{L}-]+)/iu
        );

        return (
          match[0] + (postal ? ", " + postal[1] : "")
        ).trim().slice(0, 180);
      }

      function extractTown(text) {
        const value = String(text || "").replace(/\bam\s+Tegernsee\b/gi, " ");
        const towns =
          "Bad Wiessee|Rottach-Egern|Schliersee|Kreuth|Gmund|Gmund am Tegernsee|Tegernsee";

        const postal = value.match(
          new RegExp("\\b\\d{5}\\s+(" + towns + ")\\b", "i")
        );
        if (postal) return postal[1];

        const contextual = value.match(
          new RegExp("\\b(?:in|bei|Ortsteil|OT)\\s+(" + towns + ")\\b", "i")
        );
        return contextual ? contextual[1] : "";
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
        const days =
          "Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag";

        const first = String(text || "").match(
          new RegExp("\\b(" + days + ")\\b.{0,30}\\bRuhetag\\b", "i")
        );
        if (first) return first[1];

        const second = String(text || "").match(
          new RegExp("\\bRuhetag\\s*[:：]?\\s*(" + days + ")\\b", "i")
        );
        return second ? second[1] : "";
      }

      function extractHours(text) {
        const lines = String(text || "")
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean);

        const hoursPattern =
          /\b\d{1,2}(?:[:.]\d{2})?\s*(?:Uhr)?\s*(?:-|–|—|bis|\/)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:Uhr)?/i;

        let opening = "";
        let kitchen = "";

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          if (/^öffnungszeiten\b/i.test(line)) {
            const inline = line.replace(/^öffnungszeiten\s*[:：]?\s*/i, "");
            if (hoursPattern.test(inline)) {
              opening = inline;
            } else {
              for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
                if (/^(küche|warme küche)\b/i.test(lines[j])) break;
                if (hoursPattern.test(lines[j])) {
                  opening = lines[j];
                  break;
                }
              }
            }
          }

          if (/^(warme\s+)?küche\b/i.test(line)) {
            if (hoursPattern.test(line)) kitchen = line;
            else if (lines[i + 1] && hoursPattern.test(lines[i + 1])) {
              kitchen = lines[i + 1];
            }
          }
        }

        const parts = [];
        if (opening) parts.push("Öffnungszeiten: " + opening);
        if (kitchen) parts.push("Küchenzeiten: " + kitchen);
        return parts.join("; ").slice(0, 300);
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
          oeffnungszeiten: extractHours(content),
          ruhetag: extractClosedDay(content),
          website: url && !isDirectory(url) ? url : ""
        };
      });

      function firstValue(field) {
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

      const notes = [
        "Zusammengeführter Recherchevorschlag.",
        "Bitte alle Angaben vor dem Speichern prüfen.",
        "",
        "Verwendete Quellen:",
        ...sources.map(source =>
          `- ${source.title}\n  ${source.url}` +
          (source.extracted ? "\n  Webseite zusätzlich ausgelesen." : "")
        ),
        "",
        "Nicht alle Angaben sind von jeder Quelle bestätigt."
      ].join("\n");

      return [{
        name: cleanName,
        ort: firstValue("ort"),
        kategorie: firstValue("kategorie"),
        adresse: firstValue("adresse"),
        telefon: firstValue("telefon"),
        website: firstValue("website"),
        email: firstValue("email"),
        oeffnungszeiten: firstValue("oeffnungszeiten"),
        ruhetag: firstValue("ruhetag"),
        notizen: notes.slice(0, 2200),
        reservierung: "",
        bild: ""
      }];
    }

    // --------------------------------------------------
    // API-ROUTEN
    // --------------------------------------------------

    try {
      if (request.method === "GET") {
        const url = new URL(request.url);
        const action = url.searchParams.get("action");

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
  }
};
