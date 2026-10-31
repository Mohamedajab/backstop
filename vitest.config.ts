import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Cache stress tests should not measure the public demo's traffic allowance.
        ratelimits: { REQUEST_LIMITER: { namespace_id: "1001", simple: { limit: 10000, period: 60 } } },
        serviceBindings: {
          ORIGIN: async () =>
            Response.json(
              { message: "fixture" },
              { headers: { "Cache-Control": "public, max-age=5" } },
            ),
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], testTimeout: 10_000 },
});
