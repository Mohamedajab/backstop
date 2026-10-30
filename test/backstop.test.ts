import { env, exports } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Bindings, ResourceCache } from "../src/index";
import { MAX_BYTES, readPublicResponse } from "../src/policy";
import fixture from "../fixture/index";

const url = "https://backstop.test/api/content/notice?scenario=healthy";
const publicResponse = (value = "new content") =>
  Response.json(
    { message: value },
    {
      headers: { "Cache-Control": "public, max-age=5" },
    },
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stubFor = (key = "notice?scenario=healthy") =>
  env.RESOURCES.get(env.RESOURCES.idFromName(key));

// Inject the origin at the service boundary; no test controls exist in deployed code.
async function origin(
  stub: DurableObjectStub<ResourceCache>,
  fetch: (request: RequestInfo | URL) => Promise<Response>,
) {
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as { env: Bindings };
    target.env = { ...target.env, ORIGIN: { fetch } as Fetcher };
  });
}

async function seed(age: number) {
  await runInDurableObject(stubFor(), async (_, state) => {
    await state.storage.put("content", {
      body: new TextEncoder().encode(
        JSON.stringify({ message: "saved content" }),
      ).buffer,
      headers: { "Content-Type": "application/json" },
      savedAt: Date.now() - age,
    });
  });
  await abortAllDurableObjects();
}

afterEach(async () => {
  await reset();
});

describe("origin coordination in the Workers runtime", () => {
  it("collapses 20 cold requests into one origin call, then serves fresh hits", async () => {
    let calls = 0;
    const stub = stubFor();
    await origin(stub, async () => {
      calls++;
      await sleep(70);
      return publicResponse();
    });
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => exports.default.fetch(url)),
    );
    expect(calls).toBe(1);
    expect(
      responses.filter((r) => r.headers.get("X-Backstop-Cache") === "MISS"),
    ).toHaveLength(1);
    expect(
      responses.filter(
        (r) => r.headers.get("X-Backstop-Cache") === "COALESCED",
      ),
    ).toHaveLength(19);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(await responses[0].json()).toEqual({ message: "new content" });
    expect(
      (await exports.default.fetch(url)).headers.get("X-Backstop-Cache"),
    ).toBe("HIT");
    expect(calls).toBe(1);
  });

  it("returns stale copies during one background refresh", async () => {
    await seed(6_000);
    let calls = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await origin(stubFor(), async () => {
      calls++;
      await gate;
      return publicResponse("refreshed");
    });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => exports.default.fetch(url)),
    );
    expect(
      responses.every((r) => r.headers.get("X-Backstop-Cache") === "STALE"),
    ).toBe(true);
    expect(await responses[0].json()).toEqual({ message: "saved content" });
    expect(calls).toBe(1);
    finish();
    await runInDurableObject(stubFor(), async (instance) => {
      await (instance as unknown as { inFlight?: Promise<boolean> }).inFlight;
    });
    expect(await (await exports.default.fetch(url)).json()).toEqual({
      message: "refreshed",
    });
  });

  it("keeps the good copy on failure and observes the failure cooldown", async () => {
    await seed(10_000);
    let calls = 0;
    await origin(stubFor(), async () => {
      calls++;
      return new Response("down", { status: 503 });
    });
    expect((await exports.default.fetch(url)).status).toBe(200);
    await runInDurableObject(stubFor(), async (instance) => {
      await (instance as unknown as { inFlight?: Promise<boolean> }).inFlight;
    });
    const second = await exports.default.fetch(url);
    expect(second.headers.get("X-Backstop-Origin")).toBe("cooldown");
    expect(await second.json()).toEqual({ message: "saved content" });
    expect(calls).toBe(1);
  });

  it("refuses content at the 65-second boundary and recovers after a failed refresh", async () => {
    await seed(65_000);
    let calls = 0;
    await origin(stubFor(), async () => {
      calls++;
      throw new Error("offline");
    });
    const first = await exports.default.fetch(url);
    expect(first.status).toBe(503);
    expect(first.headers.get("Retry-After")).toBe("2");
    expect((await exports.default.fetch(url)).status).toBe(503);
    expect(calls).toBe(1);
    await sleep(2_050);
    await origin(stubFor(), async () => {
      calls++;
      return publicResponse("recovered");
    });
    const recovered = await exports.default.fetch(url);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ message: "recovered" });
    expect(calls).toBe(2);
  });

  it("times out an origin that ignores abort and does not commit its late result", async () => {
    await origin(stubFor(), async () => {
      await sleep(2_200);
      return publicResponse("too late");
    });
    const start = Date.now();
    expect((await exports.default.fetch(url)).status).toBe(503);
    expect(Date.now() - start).toBeLessThan(2_180);
    await sleep(250);
    await runInDurableObject(stubFor(), async (_, state) => {
      expect(await state.storage.get("content")).toBeUndefined();
    });
  });

  it("restores fresh content and cooldowns after object restart", async () => {
    await seed(1_000);
    await origin(stubFor(), async () => {
      throw new Error("must not fetch");
    });
    expect(
      (await exports.default.fetch(url)).headers.get("X-Backstop-Cache"),
    ).toBe("HIT");
    await abortAllDurableObjects();
    expect(await (await exports.default.fetch(url)).json()).toEqual({
      message: "saved content",
    });
    await runInDurableObject(stubFor(), async (_, state) => {
      await state.storage.delete("content");
      await state.storage.put("retryAt", Date.now() + 2_000);
    });
    await abortAllDurableObjects();
    await origin(stubFor(), async () => {
      throw new Error("cooldown must survive");
    });
    expect((await exports.default.fetch(url)).status).toBe(503);
  });

  it("keeps resources and scenarios isolated", async () => {
    let calls = 0;
    for (const key of [
      "notice?scenario=healthy",
      "notice?scenario=slow",
      "timetable?scenario=healthy",
    ]) {
      await origin(stubFor(key), async () => {
        calls++;
        return publicResponse(key);
      });
      expect(
        await (
          await exports.default.fetch(
            `https://backstop.test/api/content/${key}`,
          )
        ).json(),
      ).toEqual({ message: key });
    }
    expect(calls).toBe(3);
  });
});

describe("public boundary", () => {
  it.each([
    "/api/content/notice?url=https://example.com",
    "/api/content/notice?scenario=unknown",
    "/api/content/notice?scenario=healthy&scenario=slow",
    "/api/content/secret",
    "/api/content/notice/extra",
    "/api/reset",
    "/api/content/notice?scenario=",
  ])("rejects %s", async (path) => {
    expect(
      (await exports.default.fetch(`https://backstop.test${path}`)).status,
    ).toBe(400);
  });

  it.each(["Authorization", "Cookie", "Proxy-Authorization"])(
    "rejects %s",
    async (header) => {
      expect(
        (await exports.default.fetch(url, { headers: { [header]: "secret" } }))
          .status,
      ).toBe(400);
    },
  );

  it("has a health check and refuses mutation methods", async () => {
    expect(
      (await exports.default.fetch("https://backstop.test/healthz")).status,
    ).toBe(200);
    const response = await exports.default.fetch(url, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });

  it("accepts exactly 256 KiB and cancels a streamed response over the limit", async () => {
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "public",
    };
    expect(
      (
        await readPublicResponse(
          new Response(new Uint8Array(MAX_BYTES), { headers }),
        )
      ).body.byteLength,
    ).toBe(MAX_BYTES);
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(65_536));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readPublicResponse(new Response(body, { headers })),
    ).rejects.toThrow("256 KiB");
    expect(cancelled).toBe(true);
  });

  it.each<Record<string, string>>([
    { "Set-Cookie": "private=yes" },
    { Vary: "Authorization" },
    { "Cache-Control": "private" },
    { "Cache-Control": "public, no-store" },
    { "Cache-Control": "public, no-cache" },
    { "Content-Type": "text/html" },
    { "Content-Encoding": "gzip" },
  ])("refuses unsafe origin headers %j", async (unsafe) => {
    await expect(
      readPublicResponse(
        new Response("{}", {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public",
            ...unsafe,
          },
        }),
      ),
    ).rejects.toThrow("not cacheable");
  });

  it("drops unapproved headers and does not cache errors or redirects", async () => {
    const response = publicResponse();
    response.headers.set("X-Origin-Secret", "must not escape");
    expect((await readPublicResponse(response)).headers).toEqual({
      "Content-Type": "application/json",
    });
    for (const status of [301, 404, 500])
      await expect(
        readPublicResponse(new Response("", { status })),
      ).rejects.toThrow();
  });

  it("does not replace a usable copy with an unsafe response", async () => {
    await seed(7_000);
    await origin(stubFor(), async () =>
      Response.json(
        { secret: "bad" },
        { headers: { "Set-Cookie": "session=1", "Cache-Control": "public" } },
      ),
    );
    const response = await exports.default.fetch(url);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(await response.json()).toEqual({ message: "saved content" });
    await runInDurableObject(stubFor(), async (instance) => {
      await (instance as unknown as { inFlight?: Promise<boolean> }).inFlight;
    });
    await abortAllDurableObjects();
    expect(await (await exports.default.fetch(url)).json()).toEqual({
      message: "saved content",
    });
  });

  it("the fixture emits public content and rejects non-allowlisted resources", async () => {
    const response = await fixture.fetch(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("public");
    expect(((await response.json()) as { title: string }).title).toBe(
      "Community noticeboard",
    );
    expect(
      (await fixture.fetch(new Request("https://origin/api/content/secret")))
        .status,
    ).toBe(400);
  });
});
