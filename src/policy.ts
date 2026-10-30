export const FRESH_MS = 5_000;
export const STALE_MS = 60_000;
export const TIMEOUT_MS = 2_000;
export const COOLDOWN_MS = 2_000;
export const MAX_BYTES = 256 * 1024;
export const RESOURCES = ["notice", "timetable"] as const;
export const SCENARIOS = ["healthy", "slow", "flaky"] as const;

export function contentKey(url: URL): string | null {
  const resource = url.pathname.replace("/api/content/", "");
  const scenario = url.searchParams.get("scenario") ?? "healthy";
  if (
    !url.pathname.startsWith("/api/content/") ||
    !RESOURCES.some((value) => value === resource) ||
    !SCENARIOS.some((value) => value === scenario) ||
    [...url.searchParams.keys()].some((key) => key !== "scenario") ||
    url.searchParams.getAll("scenario").length > 1
  )
    return null;
  return `${resource}?scenario=${scenario}`;
}

export function errorResponse(message: string, status: number): Response {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

// Buffer only small, explicitly public JSON; never forward arbitrary origin headers.
export async function readPublicResponse(
  response: Response,
): Promise<{ body: ArrayBuffer; headers: Record<string, string> }> {
  const cacheControl = response.headers.get("cache-control") ?? "";
  const type = response.headers.get("content-type") ?? "";
  if (
    response.status !== 200 ||
    !/^application\/json(?:;|$)/i.test(type) ||
    !/(?:^|,)\s*public\s*(?:,|$)/i.test(cacheControl) ||
    /(?:^|,)\s*(?:private|no-store|no-cache)\b/i.test(cacheControl) ||
    response.headers.has("set-cookie") ||
    response.headers.has("vary") ||
    response.headers.has("content-encoding")
  ) {
    await response.body?.cancel();
    throw new Error("Origin response is not cacheable public JSON");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new Error("Origin response exceeds 256 KiB");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: body.buffer, headers: { "Content-Type": type } };
}
