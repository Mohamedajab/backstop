import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { platform, release, cpus } from "node:os";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const gateway = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  write: false,
  format: "esm",
  external: ["cloudflare:workers"],
  target: "es2022",
});
const fixture = await build({
  entryPoints: ["fixture/index.ts"],
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
});
const originWorker = new Miniflare(
  convertV4MiniflareOptions({
    name: "fixture",
    modules: true,
    script: fixture.outputFiles[0].text,
    compatibilityDate: "2026-10-30",
  }),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samples = [];
const raw = [];
const total = 50;
const url = "https://backstop.test/api/content/notice?scenario=slow";

function summarize(run, mode, phase, results, originCalls) {
  const times = results.map((result) => result.ms).sort((a, b) => a - b);
  return {
    run,
    mode,
    phase,
    requests: results.length,
    originCalls,
    successful: results.filter((result) => result.status === 200).length,
    stale: results.filter((result) => result.cache === "STALE").length,
    p50Ms: times[Math.ceil(times.length * 0.5) - 1],
    p95Ms: times[Math.ceil(times.length * 0.95) - 1],
  };
}

try {
  for (let run = 1; run <= 3; run++) {
    let calls = 0;
    let down = false;
    const pending = new Set();
    const origin = async (request) => {
      calls++;
      const work = down
        ? sleep(80).then(
            () => new Response("controlled outage", { status: 503 }),
          )
        : originWorker.dispatchFetch(request);
      pending.add(work);
      try {
        return await work;
      } finally {
        pending.delete(work);
      }
    };
    const gatewayWorker = new Miniflare(
      convertV4MiniflareOptions({
        name: "gateway",
        modules: true,
        script: gateway.outputFiles[0].text,
        compatibilityDate: "2026-10-30",
        durableObjects: {
          RESOURCES: { className: "ResourceCache", useSQLite: true },
        },
        serviceBindings: { ORIGIN: origin },
      }),
    );
    try {
      const batch = async (mode, phase) => {
        const before = calls;
        const results = await Promise.all(
          Array.from({ length: total }, async (_, index) => {
            const start = performance.now();
            const response =
              mode === "direct"
                ? await origin(url)
                : await gatewayWorker.dispatchFetch(url);
            await response.arrayBuffer();
            return {
              index,
              status: response.status,
              cache: response.headers.get("X-Backstop-Cache"),
              ms: Math.round((performance.now() - start) * 100) / 100,
            };
          }),
        );
        // Include background refreshes in origin-call totals without timing them as client latency.
        await Promise.all([...pending]);
        const sample = summarize(run, mode, phase, results, calls - before);
        samples.push(sample);
        raw.push({ run, mode, phase, results });
        console.log(JSON.stringify(sample));
        return sample;
      };
      await gatewayWorker.ready;
      const coldDirect = await batch("direct", "cold burst");
      const coldProtected = await batch("protected", "cold burst");
      assert.equal(coldDirect.originCalls, total);
      assert.equal(coldProtected.originCalls, 1);
      assert.equal(coldProtected.successful, total);
      await batch("direct", "fresh burst");
      const fresh = await batch("protected", "fresh burst");
      assert.equal(fresh.originCalls, 0);
      await sleep(5_100);
      down = true;
      const failedDirect = await batch("direct", "outage");
      const fallback = await batch("protected", "outage");
      assert.equal(failedDirect.successful, 0);
      assert.equal(fallback.successful, total);
      assert.equal(fallback.stale, total);
      assert.equal(fallback.originCalls, 1);
      await sleep(2_100);
      down = false;
      await batch("direct", "recovery");
      await batch("protected", "recovery");
      // The recovery batch still serves stale content while one background refresh completes.
      const deadline = Date.now() + 2_000;
      let recovered;
      do {
        await sleep(25);
        recovered = await gatewayWorker.dispatchFetch(url);
        await recovered.arrayBuffer();
      } while (
        recovered.headers.get("X-Backstop-Cache") !== "HIT" &&
        Date.now() < deadline
      );
      assert.equal(recovered.headers.get("X-Backstop-Cache"), "HIT");
    } finally {
      await gatewayWorker.dispose();
    }
  }
} finally {
  await originWorker.dispose();
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
await mkdir("docs/benchmarks", { recursive: true });
const report = {
  recordedAt: new Date().toISOString(),
  command: "npm run bench",
  environment: {
    node: process.version,
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
    dependencies: pkg.devDependencies,
  },
  workload: {
    repeats: 3,
    requestsPerBatch: total,
    concurrency: total,
    originHealthyDelayMs: 500,
    outageDelayMs: 80,
    reset: "new gateway runtime and temporary SQLite storage per repeat",
  },
  caveats: [
    "Local workerd runtimes on one machine; no WAN or geographic latency.",
    "Controlled fixture outage injected only in this local harness.",
    "Direct and protected batches use the same URL and concurrency, run sequentially.",
    "Request coalescing reduces origin work; it does not speed up the first cold origin fetch.",
  ],
  samples,
  raw,
};
await writeFile(
  "docs/benchmarks/local.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  "Saved docs/benchmarks/local.json; all workload assertions passed.",
);
