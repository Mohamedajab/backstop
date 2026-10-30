import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser",
  use: {
    baseURL: process.env.BACKSTOP_URL ?? "http://localhost:8787",
    browserName: "chromium",
  },
  webServer: process.env.BACKSTOP_URL
    ? undefined
    : {
        command: "npm run dev -- --port 8787",
        url: "http://localhost:8787/healthz",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
