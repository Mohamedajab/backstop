import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import gateway from "../src/index";

const url = "https://backstop.test/api/content/notice?scenario=healthy";

function bindings(success: boolean) {
  const limit = vi.fn(async (_options: { key: string }) => ({ success }));
  const idFromName = vi.fn(() => env.RESOURCES.idFromName("test"));
  const get = vi.fn(() => ({ fetch: vi.fn(async () => Response.json({ ok: true })) }));
  const fetchAsset = vi.fn(async () => new Response("asset"));
  return { ...env, REQUEST_LIMITER: { limit }, RESOURCES: { idFromName, get }, ASSETS: { fetch: fetchAsset } };
}

describe("gateway traffic limit", () => {
  it("rejects excess traffic before looking up a cache object or origin", async () => {
    const config = bindings(false);
    const response = await gateway.fetch(new Request(url), config as unknown as typeof env);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Too many requests; try again in a minute" });
    expect(config.RESOURCES.idFromName).not.toHaveBeenCalled();
    expect(config.RESOURCES.get).not.toHaveBeenCalled();
  });

  it("uses the platform client IP and lets an allowed request reach the cache", async () => {
    const config = bindings(true);
    const request = new Request(url, { headers: { "CF-Connecting-IP": "203.0.113.7", "X-Forwarded-For": "fake" } });
    expect((await gateway.fetch(request, config as unknown as typeof env)).status).toBe(200);
    expect(config.REQUEST_LIMITER.limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
    expect(config.RESOURCES.get).toHaveBeenCalledOnce();
  });

  it("uses a shared local key when the platform header is absent", async () => {
    const config = bindings(true);
    await gateway.fetch(new Request(url), config as unknown as typeof env);
    expect(config.REQUEST_LIMITER.limit).toHaveBeenCalledWith({ key: "local-development" });
  });

  it("does not charge health, assets or invalid requests", async () => {
    const config = bindings(false);
    for (const path of ["/healthz", "/", "/api/content/unknown"]) {
      await gateway.fetch(new Request("https://backstop.test" + path), config as unknown as typeof env);
    }
    expect(config.REQUEST_LIMITER.limit).not.toHaveBeenCalled();
  });
});
