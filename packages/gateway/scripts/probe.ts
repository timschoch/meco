// The door, against a running deployment: `MECO_URL` and `MECO_KEY` from the
// environment, one line per check, exit 1 on the first line that is not what
// the ticket promised. Where every serious prototype bug was found.
//
//   MECO_URL=https://<preview> MECO_KEY=… pnpm --filter @meco/gateway probe

// A module, so the top-level awaits below are legal; nothing imports this.
export {};

const url = process.env["MECO_URL"]?.replace(/\/+$/, "");
const key = process.env["MECO_KEY"];
if (url === undefined || url === "" || key === undefined || key === "") {
  console.error("set MECO_URL and MECO_KEY");
  process.exit(2);
}

let failed = false;
const line = (ok: boolean, text: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) failed = true;
};

const basic = `Basic ${Buffer.from(`meco:${key}`).toString("base64")}`;

async function get(
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}${path}`, { headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: kept as text
  }
  return { status: res.status, body };
}

async function rpc(
  method: string,
  params?: unknown
): Promise<{ status: number; result?: unknown; error?: unknown }> {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, error: text };
  const json = res.headers.get("content-type")?.includes("text/event-stream")
    ? (text
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim() ?? "")
    : text;
  const message = JSON.parse(json) as { result?: unknown; error?: unknown };
  return { status: res.status, result: message.result, error: message.error };
}

const health = await get("/health");
const h = health.body as {
  ok?: boolean;
  records?: { reachable?: boolean };
  models?: { warm?: boolean | null; reachable?: boolean };
};
line(
  health.status === 200 && h.ok === true,
  `GET /health -> ${health.status}, records.reachable: ${String(h.records?.reachable)}, models.reachable: ${String(h.models?.reachable)}, models.warm: ${String(h.models?.warm)}`
);
console.log(`     ${JSON.stringify(health.body)}`);

for (const path of ["/v1/brands", "/v1/templates", "/v1/placements"]) {
  const none = await get(path);
  line(none.status === 401, `GET ${path} without a key -> ${none.status}`);
  const bearer = await get(path, { Authorization: `Bearer ${key}` });
  line(bearer.status === 200, `GET ${path} with Bearer -> ${bearer.status}`);
  const withBasic = await get(path, { Authorization: basic });
  line(
    withBasic.status === 200,
    `GET ${path} with Basic -> ${withBasic.status}`
  );
  const token = await get(path, { "x-auth-token": key });
  line(
    token.status === 200,
    `GET ${path} with x-auth-token -> ${token.status}`
  );
}
const brands = await get("/v1/brands", { Authorization: `Bearer ${key}` });
console.log(`     brands: ${JSON.stringify(brands.body)}`);

const wall = await get("/v1/templates?brand=not-a-brand-this-key-holds", {
  Authorization: `Bearer ${key}`,
});
line(
  wall.status === 403 &&
    (wall.body as { error?: { code?: string } }).error?.code ===
      "brand_not_held",
  `GET /v1/templates?brand=<not held> -> ${wall.status} ${JSON.stringify(wall.body)}`
);

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "meco-probe", version: "0" },
});
line(
  init.status === 200 && init.result !== undefined,
  `POST /mcp initialize -> ${init.status} ${JSON.stringify((init.result as { serverInfo?: unknown })?.serverInfo)}`
);

const list = await rpc("tools/list");
const tools =
  (list.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
line(
  list.status === 200 && tools.length > 0,
  `POST /mcp tools/list -> ${list.status}, tools: ${tools.map((t) => t.name).join(", ")}`
);

const call = await rpc("tools/call", { name: "list_brands", arguments: {} });
const text = (call.result as { content?: { text?: string }[] } | undefined)
  ?.content?.[0]?.text;
line(
  call.status === 200 && text === JSON.stringify(brands.body),
  `POST /mcp tools/call list_brands -> ${call.status}, same JSON as GET /v1/brands: ${String(text === JSON.stringify(brands.body))}`
);

// annotate (#182): a public photograph by URL, twice. The first is the whole
// Catalogue over the binding; the second is the cache. `MECO_SOURCE_URL`
// overrides the default, which is the crew fixture's own source on Commons at
// a width the binding carries (docs/specs/models.md, measurement (1)).
const sourceUrl =
  process.env["MECO_SOURCE_URL"] ??
  "https://commons.wikimedia.org/wiki/Special:FilePath/Artemis_2_Crew_Portrait.jpg?width=1600";

async function post(
  path: string,
  body: unknown
): Promise<{ status: number; body: unknown; ms: number }> {
  const at = performance.now();
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON: kept as text
  }
  return { status: res.status, body: parsed, ms: performance.now() - at };
}

/** Every key named `facePrint` anywhere in a JSON value. */
const prints = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((n, v) => n + prints(v), 0);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).reduce(
      (n, [k, v]) => n + (k === "facePrint" ? 1 : 0) + prints(v),
      0
    );
  }
  return 0;
};

/** The Step names off the Call View's HTML, in order. */
const stepsOn = (html: string): string[] =>
  [...html.matchAll(/class="step-name"[^>]*>([^<]+)</g)].map((m) => m[1] ?? "");

type AnnotateAnswer = {
  call?: { id: string };
  annotation?: { hash: string; regions: { kind: string }[]; producedBy: unknown[] };
  error?: { code: string; message: string };
};

for (const round of ["first", "second"] as const) {
  const brand = (brands.body as { id: string }[])[0]?.id ?? "laica";
  const answer = await post("/v1/annotate", {
    brand,
    source: { url: sourceUrl },
  });
  const body = answer.body as AnnotateAnswer;
  line(
    answer.status === 200 && body.call?.id !== undefined,
    `POST /v1/annotate (${round}) -> ${answer.status} in ${answer.ms.toFixed(0)} ms, call ${body.call?.id ?? "-"}, hash ${body.annotation?.hash ?? "-"}, ${body.annotation?.regions.length ?? 0} regions, producedBy ${JSON.stringify(body.annotation?.producedBy ?? [])}`
  );
  line(prints(answer.body) === 0, `     no facePrint on the wire`);
  if (round === "second") console.log(`     ${JSON.stringify(answer.body)}`);

  if (body.call?.id !== undefined) {
    const view = await get(`/ui/calls/${body.call.id}`, { Authorization: basic });
    const steps = stepsOn(String(view.body));
    const modelsRan = steps.some((s) => s.startsWith("models."));
    // The first round may already be a hit: the deployment's database keeps
    // every photograph it has seen. The second round must be one.
    line(
      view.status === 200 && (round === "first" || !modelsRan),
      `GET /ui/calls/${body.call.id} -> ${view.status}, ${modelsRan ? "models ran" : "cache hit"}, steps: ${steps.join(", ")}`
    );
  }
}

process.exit(failed ? 1 : 0);
