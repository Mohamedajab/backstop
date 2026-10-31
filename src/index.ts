import { DurableObject } from "cloudflare:workers";
import {
  COOLDOWN_MS,
  FRESH_MS,
  STALE_MS,
  TIMEOUT_MS,
  contentKey,
  errorResponse,
  readPublicResponse,
} from "./policy";

export interface Bindings {
  RESOURCES: DurableObjectNamespace<ResourceCache>;
  ORIGIN: Fetcher;
  ASSETS: Fetcher;
  REQUEST_LIMITER: RateLimit;
}

interface CachedContent {
  body: ArrayBuffer;
  headers: Record<string, string>;
  savedAt: number;
}

export class ResourceCache extends DurableObject<Bindings> {
  private cached?: CachedContent;
  private retryAt = 0;
  private inFlight?: Promise<boolean>;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.cached = await ctx.storage.get<CachedContent>("content");
      this.retryAt = (await ctx.storage.get<number>("retryAt")) ?? 0;
    });
  }

  private refresh(key: string): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    if (Date.now() < this.retryAt) return Promise.resolve(false);
    // Set the shared promise before the first I/O completes; other requests join it.
    this.inFlight = this.fetchContent(key).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchContent(key: string): Promise<boolean> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Origin timeout"));
      }, TIMEOUT_MS);
    });
    try {
      const content = await Promise.race([
        this.env.ORIGIN.fetch(`https://origin/api/content/${key}`, {
          signal: controller.signal,
          redirect: "manual",
        }).then(readPublicResponse),
        timeout,
      ]);
      const cached = { ...content, savedAt: Date.now() };
      await this.ctx.storage.put({ content: cached, retryAt: 0 });
      this.cached = cached;
      this.retryAt = 0;
      return true;
    } catch {
      this.retryAt = Date.now() + COOLDOWN_MS;
      await this.ctx.storage.put("retryAt", this.retryAt);
      console.warn(
        JSON.stringify({ event: "origin_refresh_failed", resource: key }),
      );
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private response(status: string): Response {
    const cached = this.cached!;
    return new Response(cached.body.slice(0), {
      headers: {
        ...cached.headers,
        "Cache-Control": "no-store",
        "X-Backstop-Cache": status,
        "X-Backstop-Age": String(
          Math.max(0, Math.floor((Date.now() - cached.savedAt) / 1000)),
        ),
        "X-Backstop-Origin":
          Date.now() < this.retryAt ? "cooldown" : "available-or-unchecked",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const key = contentKey(new URL(request.url));
    if (!key) return errorResponse("Unknown resource or scenario", 400);
    const age = this.cached ? Date.now() - this.cached.savedAt : Infinity;
    if (age < FRESH_MS) return this.response("HIT");
    if (age < FRESH_MS + STALE_MS) {
      this.ctx.waitUntil(this.refresh(key));
      return this.response("STALE");
    }
    const joined = Boolean(this.inFlight);
    if (await this.refresh(key))
      return this.response(joined ? "COALESCED" : "MISS");
    const response = errorResponse(
      "Origin unavailable; no usable cached content",
      503,
    );
    response.headers.set(
      "Retry-After",
      String(Math.max(1, Math.ceil((this.retryAt - Date.now()) / 1000))),
    );
    response.headers.set("X-Backstop-Cache", "UNAVAILABLE");
    return response;
  }
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    if (request.method !== "GET") {
      const response = errorResponse("Only GET is supported", 405);
      response.headers.set("Allow", "GET");
      return response;
    }
    const url = new URL(request.url);
    if (url.pathname === "/healthz")
      return Response.json(
        { status: "ok" },
        { headers: { "Cache-Control": "no-store" } },
      );
    if (url.pathname.startsWith("/api/")) {
      if (
        request.headers.has("authorization") ||
        request.headers.has("cookie") ||
        request.headers.has("proxy-authorization")
      ) {
        return errorResponse(
          "This endpoint accepts public, credential-free requests only",
          400,
        );
      }
      const key = contentKey(url);
      if (!key) return errorResponse("Unknown resource or scenario", 400);
      try {
        const { success } = await env.REQUEST_LIMITER.limit({
          key: request.headers.get("CF-Connecting-IP") ?? "local-development",
        });
        if (!success) {
          const response = errorResponse("Too many requests; try again in a minute", 429);
          response.headers.set("Retry-After", "60");
          return response;
        }
        return await env.RESOURCES.get(env.RESOURCES.idFromName(key)).fetch(
          new Request(`https://cache/api/content/${key}`),
        );
      } catch {
        return errorResponse("Cache service unavailable", 503);
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Bindings>;
