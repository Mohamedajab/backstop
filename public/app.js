const byId = (id) => document.getElementById(id);
const rows = [];
const descriptions = {
  MISS: "Fetched a new copy from the origin.",
  COALESCED: "Waited for the same refresh as another request.",
  HIT: "Returned a fresh cached copy. No origin fetch needed.",
  STALE:
    "Returned the last good copy. A refresh runs unless the origin is cooling down.",
  UNAVAILABLE: "Origin unavailable. No unexpired cached copy is stored.",
  ERROR: "Request failed. Check the connection and retry.",
};

async function send(scenario, resource) {
  const start = performance.now();
  let result;
  try {
    const response = await fetch(
      `/api/content/${resource}?scenario=${scenario}`,
      {
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    const content = await response.json();
    result = {
      status: response.status,
      state: response.headers.get("X-Backstop-Cache") ?? "ERROR",
      age: response.headers.get("X-Backstop-Age"),
      content,
    };
  } catch {
    result = { status: "—", state: "ERROR", age: null, content: {} };
  }
  return {
    ...result,
    ms: Math.round(performance.now() - start),
    time: new Date().toLocaleTimeString(),
    scenario,
  };
}

async function run(count) {
  const scenario = document.querySelector("input[name=scenario]:checked").value;
  const resource = byId("resource").value;
  byId("request-path").textContent =
    `GET /api/content/${resource}?scenario=${scenario}`;
  for (const button of document.querySelectorAll("button"))
    button.disabled = true;
  byId("feedback").textContent =
    `Sending ${count === 1 ? "a request" : "10 requests together"}…`;
  try {
    const results = await Promise.all(
      Array.from({ length: count }, () => send(scenario, resource)),
    );
    const result = results.at(-1);
    byId("latency").replaceChildren(
      document.createTextNode(String(result.ms)),
      Object.assign(document.createElement("small"), { textContent: " ms" }),
    );
    byId("age").replaceChildren(
      document.createTextNode(result.age ?? "—"),
      Object.assign(document.createElement("small"), { textContent: " s" }),
    );
    byId("http-status").textContent = result.status;
    byId("badge").textContent = result.state;
    byId("badge").dataset.state = result.state;
    byId("content-title").textContent =
      result.content.title ?? "No content available.";
    byId("content-message").textContent =
      result.content.message ?? result.content.error ?? "Please try again.";
    byId("generated").textContent = result.content.generatedAt
      ? `Origin generated this copy at ${new Date(result.content.generatedAt).toLocaleTimeString()}.`
      : "No cached content was returned.";
    byId("response-body").textContent = JSON.stringify(result.content, null, 2);
    const success = results.filter((r) => r.status === 200).length;
    byId("feedback").textContent =
      count === 1
        ? descriptions[result.state]
        : `${success}/10 successful · ${results.filter((r) => r.state === "COALESCED").length} joined a refresh · ${results.filter((r) => r.state === "HIT").length} fresh hits · ${results.filter((r) => r.state === "STALE").length} stale copies.`;
    rows.unshift(...results.reverse());
    rows.splice(20);
    byId("log").replaceChildren(
      ...rows.map((row) => {
        const tr = document.createElement("tr");
        for (const value of [
          row.time,
          row.scenario,
          row.state,
          row.age === null ? "—" : `${row.age} s`,
          `${row.ms} ms`,
          row.status,
        ]) {
          const td = document.createElement("td");
          td.textContent = value;
          tr.append(td);
        }
        return tr;
      }),
    );
  } finally {
    for (const button of document.querySelectorAll("button"))
      button.disabled = false;
  }
}

byId("single").addEventListener("click", () => run(1));
byId("burst").addEventListener("click", () => run(10));
