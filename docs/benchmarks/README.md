# Local benchmark

Run `npm ci && npm run bench` from the repository root. The script builds the
actual gateway and fixture code with esbuild and runs them in local workerd
runtimes through Miniflare. It writes [local.json](local.json), including each
request's status, cache state and measured duration, environment details and the
dependency versions requested by package.json. The exact dependency tree is in
package-lock.json.

There are three independent repeats. Each starts a new gateway runtime with
empty temporary SQLite-backed storage. Two gateway Workers share one Durable
Object namespace. Each batch sends fifty requests concurrently across both
gateways. The direct baseline and protected path use the same resource, scenario
and concurrency, sequentially. Each protected cold burst must make one origin
call across both gateways.

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

In the 31 October 2026 recorded run, fresh protected p95 latency ranged from **147.19–193.96 ms**,
against **545.25–577.37 ms** for direct-origin requests. Cold protected requests
were slower than the direct baseline: coordination does not remove the first
origin wait. Protected outage p95 ranged from **168.48–251.59 ms**.

The script asserts the origin-call counts, cold success, zero fresh origin calls,
outage success/staleness, and recovery before saving its report. The three cold
bursts reduced origin fetches from 150 to 3 (98%); the three outage batches kept
150/150 responses available using previously cached content.

## Steady traffic

After the third burst repeat, both resources are warmed, then an open-loop
schedule sends one request every 50 ms to each path for 30 seconds. Requests
alternate between the noticeboard and timetable and are split between both
gateways. Direct and protected traffic run concurrently. The controlled origin
fails between seconds 5 and 20, then recovers.

| Path | Requests | Origin calls | Successful | Failed | Stale responses | p95 latency |
| --- | --- | --- | --- | --- | --- | --- |
| Direct | 600 | 600 | 300 | 300 | 0 | 513.38 ms |
| Backstop | 600 | 18 | 600 | 0 | 303 | 8.16 ms |

Origin calls fell by 97% for this workload. Recovery assertions check both
resources contain content generated after the outage ended. This prevents an
implementation that keeps serving the same old copy from passing the check.
Per-request records include the gateway, scheduled and actual dispatch times,
status, cache state and latency.

The script asserts counts, successful fallback and recovery, rather than latency
thresholds. GitHub Actions reruns it and uploads the resulting JSON. The committed
data is from the local Windows run; CI artifact timings will differ.

These measurements describe one machine with no geographic network path. Runtime
startup, local IPC, host callbacks and scheduling affect timings. The origin's
delays and failures are injected; twenty requests per second is the scheduled
workload, not a measured capacity ceiling. No production-traffic, crash-during-refresh
or multi-region guarantee is established. Hosted smoke-check evidence is recorded
separately in hosted.json.

## Traffic admission during measurement

The harness uses the same rate-limit binding with a 10,000-request allowance
per 60 seconds, recorded in local.json. The deployed demo uses 60 per IP per
60 seconds. These measurements exercise cache behaviour under admitted load;
they do not represent throughput available to a single public-demo visitor or
measure Cloudflare's distributed rate-limit accuracy.
