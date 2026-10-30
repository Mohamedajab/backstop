import { contentKey, errorResponse } from "../src/policy";

export default {
  async fetch(request: Request): Promise<Response> {
    const key = contentKey(new URL(request.url));
    if (request.method !== "GET" || !key)
      return errorResponse("Unknown fixture", 400);
    const scenario =
      new URL(request.url).searchParams.get("scenario") ?? "healthy";
    await new Promise((resolve) =>
      setTimeout(resolve, scenario === "slow" ? 500 : 80),
    );
    // A clock-based outage is shared across isolates, with no public reset endpoint.
    if (scenario === "flaky" && Math.floor(Date.now() / 1000) % 30 >= 10) {
      return errorResponse(
        "Scheduled demo outage: 20 seconds in every 30",
        503,
      );
    }
    return Response.json(
      {
        resource: key.split("?")[0],
        title: key.startsWith("notice?")
          ? "Community noticeboard"
          : "Library opening hours",
        message: key.startsWith("notice?")
          ? "The repair cafe is open on Saturday, 10:00–13:00. Bring something worth fixing."
          : "Monday–Friday 09:00–18:00. Saturday 10:00–16:00. Closed Sunday.",
        generatedAt: new Date().toISOString(),
        scenario,
      },
      { headers: { "Cache-Control": "public, max-age=5" } },
    );
  },
} satisfies ExportedHandler;
