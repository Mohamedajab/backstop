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
    let directCalls = 0;
    let down = false;
    const pending = new Set();
    const origin = async (request, mode = "protected") => {
      calls++;
      if (mode === "direct") directCalls++;
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
        workers: ["gateway-a", "gateway-b"].map((name) => ({
          name,
          modules: true,
          script: gateway.outputFiles[0].text,
          compatibilityDate: "2026-10-30",
          durableObjects: {
            RESOURCES: {
              className: "ResourceCache",
              scriptName: "gateway-a",
              useSQLite: true,
            },
          },
          serviceBindings: { ORIGIN: (request) => origin(request) },
        })),
      }),
    );
    try {
      const gateways = await Promise.all(
        ["gateway-a", "gateway-b"].map((name) => gatewayWorker.getWorker(name)),
      );
      const measure = async (mode, path, index) => {
        const start = performance.now();
        const gatewayIndex = Math.floor(index / 2) % gateways.length;
        const response =
          mode === "direct"
            ? await origin(path, "direct")
            : await gateways[gatewayIndex].fetch(path);
        await response.arrayBuffer();
        return {
          index,
          gateway:
            mode === "direct"
              ? null
              : `gateway-${gatewayIndex === 0 ? "a" : "b"}`,
          status: response.status,
          cache: response.headers.get("X-Backstop-Cache"),
          ms: Math.round((performance.now() - start) * 100) / 100,
        };
      };
      const batch = async (mode, phase) => {
        const before = calls;
        const results = await Promise.all(
          Array.from({ length: total }, (_, index) =>
            measure(mode, url, index),
          ),
        );
        if (mode === "protected")
          assert.equal(
            new Set(results.map((result) => result.gateway)).size,
            2,
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

      if (run === 3) {
        const resources = ["notice", "timetable"].map(
          (resource) =>
            `https://backstop.test/api/content/${resource}?scenario=slow`,
        );
        for (const path of resources) {
          const warm = await gateways[0].fetch(path);
          assert.equal(warm.status, 200);
          await warm.arrayBuffer();
        }
        const before = calls;
        const beforeDirect = directCalls;
        const started = Date.now();
        const requests = [];
        // An open-loop schedule keeps arrivals going even while earlier requests are slow.
        for (let index = 0; index < 600; index++) {
          await sleep(Math.max(0, started + index * 50 - Date.now()));
          const elapsed = Date.now() - started;
          down = elapsed >= 5_000 && elapsed < 20_000;
          for (const mode of ["direct", "protected"]) {
            requests.push(
              measure(mode, resources[index % resources.length], index).then(
                (result) => ({
                  ...result,
                  mode,
                  scheduledMs: index * 50,
                  dispatchedMs: elapsed,
                }),
              ),
            );
          }
        }
        const results = await Promise.all(requests);
        await Promise.all([...pending]);
        const directOriginCalls = directCalls - beforeDirect;
        const protectedOriginCalls = calls - before - directOriginCalls;
        for (const mode of ["direct", "protected"]) {
          const measurements = results.filter((result) => result.mode === mode);
          const sample = summarize(
            run,
            mode,
            "steady traffic, outage and recovery",
            measurements,
            mode === "direct" ? directOriginCalls : protectedOriginCalls,
          );
          samples.push(sample);
          raw.push({ run, mode, phase: sample.phase, results: measurements });
          console.log(JSON.stringify(sample));
        }
        assert.equal(directOriginCalls, 600);
        assert.equal(
          results.filter(
            (result) => result.mode === "protected" && result.status === 200,
          ).length,
          600,
        );
        assert.ok(
          results.some(
            (result) => result.mode === "direct" && result.status === 503,
          ),
        );
        assert.ok(
          protectedOriginCalls < 60,
          "Origin work should fall by more than 90% for this workload",
        );
        for (const path of resources) {
          const response = await gateways[0].fetch(path);
          const content = await response.json();
          assert.ok(
            Date.parse(content.generatedAt) >= started + 20_000,
            "Content must refresh after recovery",
          );
        }
      }
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
    gateways: ["gateway-a", "gateway-b"],
    coordination:
      "Both gateway Workers reference the same Durable Object namespace on gateway-a",
    originHealthyDelayMs: 500,
    outageDelayMs: 80,
    reset: "new gateway runtime and temporary SQLite storage per repeat",
    steadyTraffic: {
      repeats: 1,
      durationMs: 30_000,
      requestsPerSecondPerMode: 20,
      resources: 2,
      startsWarm: true,
      outageFromMs: 5_000,
      outageUntilMs: 20_000,
      scope: "local only",
    },
  },
  caveats: [
    "Local workerd runtimes on one machine; no WAN or geographic latency.",
    "Controlled fixture outage injected only in this local harness.",
    "Burst baselines run sequentially; steady traffic runs both modes concurrently.",
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
