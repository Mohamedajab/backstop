import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const base = new URL(process.argv[2] ?? "https://backstop.backstop.workers.dev");
const samples = [];
async function get(path) {
  const response = await fetch(new URL(path, base), {
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  samples.push({ path, status: response.status, retryAfter: response.headers.get("Retry-After") });
  return { response, body };
}

let rejected = false;
for (let attempt = 0; attempt < 90; attempt++) {
  const { response, body } = await get("/api/content/notice?scenario=healthy");
  if (response.status === 429) {
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(response.headers.get("Content-Type") ?? "", /application\/json/);
    assert.equal(JSON.parse(body).error, "Too many requests; try again in a minute");
    rejected = true;
    break;
  }
  assert.equal(response.status, 200);
}
assert.ok(rejected, "No rejection observed within 90 requests; check the binding and platform location");
for (const path of ["/healthz", "/", "/app.js"]) {
  assert.equal((await get(path)).response.status, 200);
}
assert.equal((await get("/api/content/unknown")).response.status, 400);

await mkdir("docs/benchmarks", { recursive: true });
await writeFile("docs/benchmarks/rate-limit-hosted.json", JSON.stringify({
  recordedAt: new Date().toISOString(), base: base.origin,
  command: `node scripts/rate-limit-smoke.mjs ${base.origin}`,
  caveat: "Bounded check from one client. Earlier traffic shares its allowance. Platform counters are approximate and per location; this does not measure an exact threshold or an account-wide cap. Run the ordinary smoke/browser checks before this check, or wait for the allowance to refill.",
  checks: { rejected, excludedPathsAvailable: true }, samples,
}, null, 2) + "\n");
console.log(`Rate-limit checks passed; ${samples.length} requests, saved docs/benchmarks/rate-limit-hosted.json.`);
