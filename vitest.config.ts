import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
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
