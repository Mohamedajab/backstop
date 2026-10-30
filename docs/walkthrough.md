# A short walkthrough

## Explain it in a minute

Backstop explores a failure mode of simple caches: when a cached response expires,
many clients can all try to refresh it at once. It gives each public resource one
Durable Object, which keeps the last good response and shares one refresh promise.
Requests get a fresh copy, a recent stale copy during refresh, or a bounded wait
when nothing usable is stored.

In three local experiments, fifty concurrent cold requests needed one origin
fetch each time. During a controlled outage all fifty protected requests in each
repeat returned the saved copy. The direct baseline failed. Those results show
less origin work and useful failure behaviour; they do not establish production
scale.

## Show it in three minutes

1. Open the demo and send a healthy request. Point to the cache-state and age headers.
2. Repeat within five seconds to show `HIT`. Wait six seconds and request again
   to show `STALE`; the next request should show the refreshed copy.
3. Choose the slow preset and send ten together. A cold run should show a miss
   and joined requests. If another visitor already warmed it, explain the shared
   state instead of promising a cold cache.
4. Warm the intermittent preset in the first ten seconds of a 30-second cycle.
   Request during its twenty-second outage and show stale content. A cold request
   during downtime can return 503, which is expected.
5. Open `src/index.ts`, the concurrent cold-request test and `docs/benchmarks/local.json`.

## Decisions worth discussing

- **Why a Durable Object?** Requests need one coordination point per resource,
  including requests arriving at different Workers. A promise in a gateway isolate
  would only combine requests within that isolate. The object costs an extra hop
  and can become a hotspot.
- **Why persist content but not the promise?** Content and cooldown timestamps
  can survive restarts. A pending network operation cannot safely be serialized.
  Another refresh after a crash is acceptable for these read-only public resources.
- **Why only public JSON?** It gives the experiment a clear trust boundary.
  Forwarding arbitrary origin responses would require a much fuller HTTP cache policy.
- **Why return stale before knowing whether the origin failed?** It avoids adding
  refresh latency to the client path. The UI therefore does not call STALE proof
  of an outage; the local harness controls and records that condition separately.
- **What would change for a real service?** First check whether Cloudflare's
  native cache and stale controls solve the need. Measure the hot-key bottleneck,
  define content-specific freshness, add traffic budgets and storage cleanup,
  then validate with the actual origin and users.

## About AI assistance

AI helped produce the implementation and checks. Explain the shared promise,
failure paths and experimental limits in your own words. Re-run the tests and
change a policy value locally before an interview so you can show what changes
and why. Do not imply this ran under real customer traffic.
