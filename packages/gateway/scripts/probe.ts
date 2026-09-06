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

process.exit(failed ? 1 : 0);
