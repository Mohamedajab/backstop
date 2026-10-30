# Local benchmark

Run `npm ci && npm run bench` from the repository root. The script builds the
actual gateway and fixture code with esbuild and runs them in local workerd
runtimes through Miniflare. It writes [local.json](local.json), including each
request's status, cache state and measured duration, environment details and the
dependency versions requested by package.json. The exact dependency tree is in
package-lock.json.

There are three independent repeats. Each starts a new gateway runtime with
empty temporary SQLite-backed storage. Each batch sends fifty requests
concurrently. The direct baseline and protected path use the same resource,
scenario and concurrency, sequentially.

| Phase | Direct origin calls, per repeat | Protected origin calls, per repeat | Protected successful responses |
| --- | --- | --- | --- |
| Cold burst | 50 | 1 | 50/50 |
| Fresh burst | 50 | 0 | 50/50 |
| Outage after cache becomes stale | 50 | 1 | 50/50, all stale |
| Recovery after cooldown | 50 | 1 | 50/50, initially stale |

The slow fixture normally waits 500 ms. The harness then injects an 80 ms failure
at the private service boundary for the outage phase. This gives a repeatable
outage independent of the live demo's clock cycle. Background refreshes count
towards origin calls but not towards completed client latency. A final assertion
waits for a fresh hit after recovery; those probes are outside the timed batches.

In the recorded run, fresh protected p95 latency ranged from **64.26–111.01 ms**,
against **552.47–582.63 ms** for direct-origin requests. Cold protected requests
were slower than the direct baseline: coordination does not remove the first
origin wait. Protected outage p95 ranged from **90.42–220.95 ms**, showing why the
more useful conclusion is successful stale fallback and fewer origin calls,
rather than a claim that every request gets faster.

The script asserts the origin-call counts, cold success, zero fresh origin calls,
outage success/staleness, and recovery before saving its report. The three cold
bursts reduced origin fetches from 150 to 3 (98%); the three outage batches kept
150/150 responses available using previously cached content.

These measurements describe one Windows machine with no geographic network
path. Runtime startup, local IPC, host callbacks and scheduling affect timings.
The baseline and protected batches do not run simultaneously. There is no
throughput, sustained-load, crash-during-refresh or multi-region guarantee.
Hosted smoke-check evidence is recorded separately in hosted.json.
