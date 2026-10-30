# CV-ready project entry

**Backstop — Origin protection on Cloudflare Workers**

TypeScript · Cloudflare Workers · Durable Objects · SQLite · Vitest · GitHub Actions

Source: https://github.com/Mohamedajab/backstop

Live demo: https://backstop.backstop.workers.dev

- Built a public-content cache with per-resource request coalescing, persistent
  stale fallback, origin timeouts and failure cooldowns; verified concurrency,
  recovery and response safety with 29 runtime test cases.
- Reduced origin fetches from 150 to 3 across three local 50-request cold-burst
  experiments; served 150/150 protected outage requests from cached content,
  with reproducible benchmarks and a browser-tested interactive demo.

These numbers come from the committed local benchmark, not production traffic.
Use this entry after you have run the project and can explain the implementation.
Existing CV files have not been changed.
