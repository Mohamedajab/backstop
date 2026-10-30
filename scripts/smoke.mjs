import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const base = new URL(
  process.argv[2] ?? "https://backstop.backstop.workers.dev",
);
const samples = [];
async function get(path, options) {
  const start = performance.now();
  const response = await fetch(new URL(path, base), {
    ...options,
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  samples.push({
    path,
    status: response.status,
    cache: response.headers.get("X-Backstop-Cache"),
    age: response.headers.get("X-Backstop-Age"),
    origin: response.headers.get("X-Backstop-Origin"),
    cacheControl: response.headers.get("Cache-Control"),
    ms: Math.round(performance.now() - start),
  });
  return { response, body };
}

const home = await get("/");
assert.equal(home.response.status, 200);
assert.match(home.body, /Give the origin a hard day/);
assert.ok(home.response.headers.get("Content-Security-Policy"));
assert.equal((await get("/healthz")).response.status, 200);
const first = await get("/api/content/notice?scenario=healthy");
assert.equal(first.response.status, 200);
assert.equal(first.response.headers.get("Cache-Control"), "no-store");
const freshDeadline = Date.now() + 3_000;
let healthyState;
do {
  await new Promise((resolve) => setTimeout(resolve, 100));
  healthyState = (
    await get("/api/content/notice?scenario=healthy")
  ).response.headers.get("X-Backstop-Cache");
} while (healthyState !== "HIT" && Date.now() < freshDeadline);
assert.equal(healthyState, "HIT");
const burst = await Promise.all(
  Array.from({ length: 10 }, () => get("/api/content/timetable?scenario=slow")),
);
assert.ok(burst.every((result) => result.response.status === 200));
assert.equal(
  (await get("/api/content/notice?url=https://example.com")).response.status,
  400,
);
assert.equal(
  (
    await get("/api/content/notice", {
      headers: { Authorization: "Bearer synthetic-test" },
    })
  ).response.status,
  400,
);
assert.equal(
  (await get("/api/content/notice", { method: "POST" })).response.status,
  405,
);

let warmed = false;
let stale = false;
let cooldown = false;
const deadline = Date.now() + 45_000;
while (Date.now() < deadline && !(warmed && stale && cooldown)) {
  const { response } = await get("/api/content/notice?scenario=flaky");
  warmed ||= response.status === 200;
  stale ||= response.headers.get("X-Backstop-Cache") === "STALE";
  cooldown ||= response.headers.get("X-Backstop-Origin") === "cooldown";
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
assert.ok(
  warmed && stale && cooldown,
  "Observe warm content, stale fallback and origin failure cooldown on the hosted demo",
);
await mkdir("docs/benchmarks", { recursive: true });
await writeFile(
  "docs/benchmarks/hosted.json",
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      base: base.origin,
      command: `npm run smoke -- ${base.origin}`,
      checks: { warmed, stale, cooldown },
      caveat:
        "Bounded smoke check from one client against shared demo state; not a load test. Fixture has workers_dev and preview_urls disabled in its deployed configuration.",
      samples,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Hosted checks passed; ${samples.length} requests, saved docs/benchmarks/hosted.json.`,
);
