# Design notes

```text
browser → gateway Worker → Durable Object → fixture Worker
                                  ↕
                           SQLite storage
```

The gateway validates the method, resource and scenario, then routes to an object
named by the resource/scenario pair. There are six possible keys. The fixture is
reachable only through a service binding and has no public route.

## Refresh coordination

A promise on the gateway would combine requests within one isolate. The Durable
Object provides a coordination point for requests arriving through different
isolates. Each object holds one refresh promise, assigned before the first I/O
completes. Cold requests await it; stale requests return immediately and attach
the refresh to `waitUntil`. The promise clears in `finally`, including failures.

This trades an extra hop and a hot-key bottleneck for coordination. Fresh requests
also pass through the object. This implementation does not use the edge Cache API.

## Storage and failures

The constructor loads the last successful response and cooldown timestamp before
accepting requests. Successful refreshes persist the body, retained headers and
fetch time before updating the in-memory copy. A failed refresh preserves the
old content and persists a two-second cooldown.

At 65 seconds, stored content is no longer served as fallback. A request without
usable content waits up to two seconds for a refresh and gets `503` on failure.
The timeout includes response-body reading. Late origin results cannot update the
cache, though an origin ignoring cancellation can continue doing work.

An in-flight fetch is not persisted. Restarting an object can cause a new fetch
while previous origin work is still running. Read-only fixture resources tolerate
this; there is no exactly-once guarantee across crashes.

## Response boundary

Cache policy is fixed for the two public sample resources. This is not an HTTP
cache implementation for arbitrary upstream services. Requests with credentials
are rejected. Origin responses must be HTTP 200, explicitly public JSON, without
cookies, Vary, content encoding or private/no-cache/no-store directives.

Body reading is streamed and cancelled above 256 KiB, even without Content-Length.
Only Content-Type is kept. The gateway constructs the upstream URL and supplies
no client headers. Browser caching is disabled on the outgoing response so each
demo request exercises the gateway.

## Measurement

The local benchmark routes requests through two gateway Workers that reference
the same object namespace. The cold-burst assertion requires one origin fetch
across both gateways; separate gateway-local caches would fetch twice.

Three repeats compare fifty-request bursts directly against the fixture and
through the gateways. A separate open-loop schedule sends twenty requests per
second to each path for thirty seconds, across two resources. New requests arrive
without waiting for earlier ones to finish. The origin is down between seconds
5 and 20; recovery checks require new content generated after second 20.

The harness counts origin calls at the service boundary. Client timing stops when
the body is read; background work is counted separately. Burst storage is reset
between repeats. The steady-traffic run warms both resources before recording.

The hosted demo is shared. `STALE` means a cached copy was returned while a refresh
was started, joined or skipped during cooldown. It does not by itself establish
that the origin is down. Hosted checks observe the failure cooldown separately.

## Public demo traffic

The gateway checks valid content requests against REQUEST_LIMITER before looking
up a cache object. Cloudflare supplies CF-Connecting-IP; absent that header,
local requests share the local-development key. Invalid requests, health and
static files do not consume that allowance. A rejected request returns 429,
no-store JSON and Retry-After: 60; the latter is a conservative retry hint,
not the exact reset time. Binding failures return 503 without reaching the cache.

The binding is configured for 60 requests per 60 seconds. Cloudflare's counters
are approximate and per location, not a global traffic or cost ceiling. The
namespace ID must be distinct from unrelated bindings in the same account.
The benchmark and cache stress tests use a 10,000-request test allowance; the
browser test uses the real 60-request configuration. This keeps cache measurements
separate from admission rejection tests.

[Platform behaviour](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
