# Verification and CV notes

30 October 2026, Windows, Node v24.16.0. The exact dependency tree is in package-lock.json.

- `npm ci`: installed successfully, no reported vulnerabilities.
- `npm run check`: type generation/checking, 33 Workers tests and both deployment dry runs passed.
- `npm run bench`: all workload assertions passed. Three cold bursts used 3 origin calls for 150 requests. The steady outage test returned 600/600 successful protected responses using 18 origin calls; the direct path failed 300/600.
- `npx playwright install chromium` and `npm run test:browser`: one browser test passed, including keyboard interaction, axe checks and widths 375, 768 and 1440.

The benchmark's complete request records and environment are in `benchmarks/local.json`.
It uses a higher admission allowance (10,000/60s) to measure cache behaviour under load.
The public deployment remains configured at 60/IP/60s. No hosted configuration was changed.
Admission regressions verify client-IP selection, the local fallback, excluded paths and
429/no-store/Retry-After responses without accessing a cache object.

Limits: platform counters are approximate and per location. Shared IPs share an allowance;
distributed visitors can still exhaust account quotas. This is not a spending cap.
The local benchmark is not a production load test.

## Suggested CV bullets

- Built a TypeScript cache on Cloudflare Workers with persistent stale fallback and shared origin refreshes.
- Added platform traffic admission and tested outage recovery; a local 600-request workload served every request using 18 origin fetches while the direct path failed 300 requests.
