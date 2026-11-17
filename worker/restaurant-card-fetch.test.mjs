import test from "node:test";
import assert from "node:assert/strict";
import { fetchRestaurantCardHash } from "./restaurant-card-fetch.mjs";

const pdf = "%PDF-1.7\nRestaurant menu content";

test("retries HTTP 429 once and then hashes the menu", async () => {
  let calls = 0;
  const result = await fetchRestaurantCardHash("https://menu.example/karte.pdf", async () => {
    calls++;
    if (calls === 1) return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
    return new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf" } });
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "ok");
  assert.match(result.hash, /^[a-f0-9]{64}$/);
});

test("keeps PDFs above 1 MB eligible for content comparison", async () => {
  const largePdf = "%PDF-1.7\n" + "x".repeat(1_200_000);
  const result = await fetchRestaurantCardHash("https://menu.example/large.pdf", async () =>
    new Response(largePdf, { status: 200, headers: { "Content-Type": "application/pdf" } })
  );
  assert.equal(result.status, "ok");
  assert.match(result.hash, /^[a-f0-9]{64}$/);
});

test("stops safely above the 5 MB document limit", async () => {
  const tooLarge = "%PDF-1.7\n" + "x".repeat(5 * 1024 * 1024 + 1);
  const result = await fetchRestaurantCardHash("https://menu.example/huge.pdf", async () =>
    new Response(tooLarge, { status: 200, headers: { "Content-Type": "application/pdf" } })
  );
  assert.equal(result.status, "too_large");
  assert.match(result.detail, /über 5 MB/);
});

test("records persistent HTTP 429 after two attempts without inventing a hash", async () => {
  let calls = 0;
  const result = await fetchRestaurantCardHash("https://menu.example/blocked.pdf", async () => {
    calls++;
    return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "unreachable");
  assert.match(result.detail, /HTTP 429 nach zwei Abrufversuchen/);
  assert.equal(result.hash, undefined);
});

test("rejects unsafe local and non-HTTP URLs before fetching", async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchRestaurantCardHash("http://127.0.0.1/private", async () => {
      calls++;
      return new Response("should not fetch");
    }),
    /URL aus Sicherheitsgründen/
  );
  assert.equal(calls, 0);
});
