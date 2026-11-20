// Bounded, retry-aware fetch for official restaurant menu documents.
// Only hashes are stored; restaurant records and document files are never modified.
const MAX_BYTES = 7 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 2;

function safeUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) ||
      /^224\./.test(host) || /^240\./.test(host) || host === "0.0.0.0" ||
      host === "::1" || host.startsWith("::ffff:") || host.startsWith("fc") ||
      host.startsWith("fd") || host.startsWith("fe80:") || host.startsWith("ff") ||
      host === "169.254.169.254") return null;
  return url;
}

function retryDelay(response, attempt) {
  const header = response?.headers?.get?.("Retry-After");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 2000);
    const until = Date.parse(header) - Date.now();
    if (Number.isFinite(until) && until > 0) return Math.min(until, 2000);
  }
  return attempt * 1000;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function fetchRestaurantCardHash(rawUrl, fetchImpl = fetch) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      let current = rawUrl;
      let response;
      for (let hop = 0; hop <= 3; hop++) {
        const parsed = safeUrl(current);
        if (!parsed) throw new Error("URL aus Sicherheitsgründen nicht geprüft.");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          response = await fetchImpl(parsed.href, {
            redirect: "manual",
            signal: controller.signal,
            headers: {
              "User-Agent": "TegernseeRestaurantMenuChecker/1.1",
              "Accept": "application/pdf,application/octet-stream,text/html,*/*;q=0.5"
            }
          });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("Location");
            if (!location || hop === 3) throw new Error("Weiterleitung nicht auflösbar.");
            current = new URL(location, parsed.href).href;
            try { await response.body?.cancel(); } catch { /* redirect body is not needed */ }
            continue;
          }
          if ([408, 425, 429].includes(response.status) || response.status >= 500) {
            if (attempt < MAX_ATTEMPTS) {
              const delay = retryDelay(response, attempt);
              clearTimeout(timer);
              try { await response.body?.cancel(); } catch { /* retry response body is not needed */ }
              await wait(delay);
              response = null;
              break;
            }
            return {
              status: "unreachable",
              detail: response.status === 429
                ? "HTTP 429 nach zwei Abrufversuchen (Rate-Limit)."
                : "HTTP " + response.status + " nach zwei Abrufversuchen."
            };
          }
          if (!response.ok) {
            return { status: "unreachable", detail: "HTTP " + response.status };
          }
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Antwortinhalt nicht lesbar.");
          const chunks = [];
          let total = 0;
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > MAX_BYTES) {
              await reader.cancel();
              return { status: "too_large", detail: "Quelle über 7 MB; Inhaltsvergleich aus Sicherheitsgründen übersprungen." };
            }
            chunks.push(part.value);
          }
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
          return { status: "ok", detail: "Quelle erreichbar; Inhalt geprüft.", hash };
        } finally {
          clearTimeout(timer);
        }
      }
      // A retryable HTTP response has already waited and left the hop loop.
      if (response === null) continue;
      if (!response) throw new Error("Keine Antwort von der Quelle.");
    } catch (error) {
      lastError = error;
      const transient = error?.name === "AbortError" || error instanceof TypeError;
      if (attempt < MAX_ATTEMPTS && transient) {
        await wait(attempt * 500);
        continue;
      }
      if (!transient) throw error;
    }
  }
  if (lastError?.name === "AbortError" || /timed? ?out|timeout/i.test(String(lastError?.message || lastError))) {
    throw new Error("Zeitüberschreitung nach zwei Abrufversuchen.");
  }
  throw lastError || new Error("Quelle konnte nach zwei Abrufversuchen nicht geprüft werden.");
}
