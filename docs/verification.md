# Verification and CV notes

31 October 2026, Windows 11 (10.0.26200), Node v24.16.0. The exact dependency tree is in package-lock.json.

- `npm ci`: installed successfully on 30 October, no reported vulnerabilities; the same installed dependency tree was reused for this rerun.
- `npm run check`: type generation/checking, 33 Workers tests and both deployment dry runs passed.
- `npm run bench`: all workload assertions passed. Three cold bursts used 3 origin calls for 150 requests. The steady outage test returned 600/600 successful protected responses using 18 origin calls; the direct path failed 300/600.
- `npx playwright install chromium` and `npm run test:browser`: one browser test passed, including keyboard interaction, axe checks and widths 375, 768 and 1440.

The benchmark's complete request records and environment are in `benchmarks/local.json`.
It uses a higher admission allowance (10,000/60s) to measure cache behaviour under load.
The public deployment configuration is 60/IP/60s; hosted checks are recorded below.
Admission regressions verify client-IP selection, the local fallback, excluded paths and
429/no-store/Retry-After responses without accessing a cache object.

Limits: platform counters are approximate and per location. Shared IPs share an allowance;
distributed visitors can still exhaust account quotas. This is not a spending cap.
The local benchmark is not a production load test.

## Hosted verification, 31 October 2026

CI on `c5edf23538315fad2b84728991cf553eb567fe01` passed all checks, including
the benchmark and Chromium test: [run 41149825391](https://github.com/Mohamedajab/backstop/actions/runs/41149825391).
PR #2 is merged into main. `npx wrangler deploy` uploaded the gateway with the
`REQUEST_LIMITER` binding at 60 requests/60 seconds; version
`f94a85b4-b859-4db9-a263-607470fb5afe`. The private origin Worker was unchanged.

```sh
BACKSTOP_URL=https://backstop.backstop.workers.dev npm run test:browser
npm run smoke -- https://backstop.backstop.workers.dev
node scripts/rate-limit-smoke.mjs https://backstop.backstop.workers.dev
```

PowerShell: set `$env:BACKSTOP_URL='https://backstop.backstop.workers.dev'` before
`npm run test:browser`. Run the rate-limit check last; it deliberately consumes
this client's allowance. Wait for the window to refill before repeating ordinary
browser or smoke checks.

The browser test passed, including keyboard, axe and viewport checks. The ordinary
smoke passed with 44 requests, observing warm content, stale fallback and cooldown;
its responses are in [hosted.json](benchmarks/hosted.json).
The bounded limit check passed with 62 requests including excluded paths: it
observed an allowed response, then JSON 429 with no-store and Retry-After: 60.
Health, the page and JavaScript still returned 200; an invalid content path returned
400. See [rate-limit-hosted.json](benchmarks/rate-limit-hosted.json).

This observes one client's allowance, including earlier traffic; it does not prove
an exact distributed cutoff. The unit regression proves rejection occurs before
cache-object lookup, so the rejected request cannot call the origin through it.

## Suggested CV bullets

- Built a TypeScript cache on Cloudflare Workers with persistent stale fallback and shared origin refreshes.
- Added platform traffic admission and tested outage recovery; a local 600-request workload served every request using 18 origin fetches while the direct path failed 300 requests.
