/**
 * Prove that an MCP exchange over `/mcp` ends.
 *
 * A response whose body never closes keeps the whole container alive until the
 * platform's max duration kills it — idle clients alone were costing hours of
 * runtime a day. Headers arriving quickly proves nothing: what matters is when
 * the *body* ends, so every probe reads the stream to completion under a clock.
 *
 * Drives the MCP handler in-process — no port, no container, no Vercel. Both
 * `/mcp` routes in `src/app.ts` hand the raw request straight to this
 * handler, so this is the same code path a real client reaches.
 */
import { setTimeout as delay } from "node:timers/promises";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import { createMecoMcpHandler } from "../src/mcp.js";
import { createStorage } from "../src/storage.js";

const mcp = createMecoMcpHandler(createStorage());

/** Well past any real handler, far below the platform's 60s cap. */
const BUDGET_MS = 5_000;

interface Probe {
  label: string;
  status: number;
  contentType: string;
  headerMs: number;
  /** Milliseconds until the body ended, or null if it was still open at BUDGET_MS. */
  bodyMs: number | null;
  body: string;
  /** The whole body, for checks that read the payload rather than the clock. */
  full: string;
}

async function probe(
  label: string,
  body: { method: string; params?: Record<string, unknown> },
  protocolVersion: string,
  modern: boolean,
): Promise<Probe> {
  const started = performance.now();
  const res = await mcp.fetch(
    new Request("http://local/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocolVersion,
        // The 2026 era routes on the header and rejects a body that disagrees.
        // A `tools/call` names the tool in a second header for the same reason.
        ...(modern ? { "mcp-method": body.method } : {}),
        ...(modern && typeof body.params?.name === "string"
          ? { "mcp-name": body.params.name }
          : {}),
      },
      body: JSON.stringify(body),
    }),
  );
  const headerMs = performance.now() - started;

  // Drain the body against the clock. `res.text()` alone would hang forever on
  // a stream that is never closed, which is precisely the bug under test.
  let text = "";
  const drained = res
    .text()
    .then((t) => {
      text = t;
      return performance.now() - started;
    })
    .catch(() => performance.now() - started);
  const bodyMs = await Promise.race([drained, delay(BUDGET_MS, null)]);

  return {
    label,
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    headerMs,
    bodyMs,
    body: text.replace(/\s+/g, " ").slice(0, 600),
    full: text,
  };
}

const LEGACY_VERSION = "2025-06-18";
const MODERN_VERSION = "2026-07-28";

/** 2025 handshake. The modern era has no `initialize` — every request stands alone. */
const legacyInitialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: LEGACY_VERSION,
    capabilities: {},
    clientInfo: { name: "mcp-probe", version: "0" },
  },
};

/** The 2026 per-request envelope every modern request must carry. */
const modernMeta = {
  [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION,
  [CLIENT_INFO_META_KEY]: { name: "mcp-probe", version: "0" },
  [CLIENT_CAPABILITIES_META_KEY]: {},
};

/**
 * `subscriptions/listen` is the 2026 spec's long-lived change feed. The SDK
 * always serves it over SSE and holds the stream open waiting for events. On a
 * metered container that is an invocation that never ends — and meco has
 * nothing to push, so the wait is forever.
 */
const LISTEN_PARAMS = { notifications: { toolsListChanged: true } };

const METHODS = [
  { method: "tools/list", params: {} },
  { method: "subscriptions/listen", params: LISTEN_PARAMS },
];

const request = (
  id: number,
  { method, params }: { method: string; params: Record<string, unknown> },
  era: "legacy" | "modern",
) => ({
  jsonrpc: "2.0",
  id,
  method,
  params: era === "modern" ? { ...params, _meta: modernMeta } : params,
});

const probes: Probe[] = [];

probes.push(await probe("legacy initialize", legacyInitialize, LEGACY_VERSION, false));
let id = 2;
for (const [era, version] of [
  ["legacy", LEGACY_VERSION],
  ["modern", MODERN_VERSION],
] as const) {
  for (const spec of METHODS) {
    const modern = era === "modern";
    probes.push(
      await probe(`${era} ${spec.method}`, request(id++, spec, era), version, modern),
    );
  }
}

/**
 * A Subject Area outside the frame has to be refused over MCP too.
 *
 * The rule itself is `api.subjectAreaShape`, shared with the HTTP route, so what
 * this proves is only that the tool is wired to it — but that is the half a
 * shared schema cannot prove about itself. A refused call never reaches storage
 * or the network, and the Source Image is a `data:` URL so a call that somehow
 * got through would still not leave the process.
 */
const PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

probes.push(
  await probe(
    "modern crop_image bad area",
    request(
      id++,
      {
        method: "tools/call",
        params: {
          name: "crop_image",
          arguments: {
            source: PIXEL,
            width: 1080,
            height: 1350,
            subjectArea: { x: 0.8, y: 0.1, width: 0.4, height: 0.4 },
          },
        },
      },
      "modern",
    ),
    MODERN_VERSION,
    true,
  ),
);

for (const p of probes) {
  const body = p.bodyMs === null ? "NEVER CLOSED" : `${p.bodyMs.toFixed(0)}ms`;
  console.log(
    `${p.bodyMs === null ? "HANG  " : "ok    "} ${p.label.padEnd(24)} ` +
      `${String(p.status)}  headers=${p.headerMs.toFixed(0)}ms  body=${body}  ${p.contentType}` +
      `\n         ${p.body}`,
  );
}

// ------------------------------------------------------------- the tool shape

/**
 * The JSON out of an exchange, whichever transport it arrived on.
 *
 * The SDK answers some methods as JSON and some as a one-event SSE stream, and
 * which is which is its business, not this script's.
 */
function payload(text: string): unknown {
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("");
  try {
    return JSON.parse(events || text);
  } catch {
    return null;
  }
}

interface ToolListing {
  result?: {
    tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[];
  };
}

/** Refused either way the SDK can refuse: a JSON-RPC error, or a tool that said no. */
function refused(text: string): boolean {
  const answer = payload(text) as { error?: unknown; result?: { isError?: boolean } } | null;
  return answer !== null && (answer.error !== undefined || answer.result?.isError === true);
}

/**
 * `crop_image` has to advertise `subjectArea`, or an MCP client has no way to
 * know it may send one — the validation is shared with HTTP, but the schema a
 * client reads is only written here.
 */
const listed = probes.find((p) => p.label === "modern tools/list");
const tools = (payload(listed?.full ?? "") as ToolListing | null)?.result?.tools ?? [];
const cropTool = tools.find((t) => t.name === "crop_image");
const advertised = cropTool?.inputSchema?.properties?.subjectArea !== undefined;
console.log(
  `${advertised ? "ok    " : "FAIL  "} crop_image advertises subjectArea` +
    `  — ${String(tools.length)} tools listed`,
);

const rejected = refused(probes.find((p) => p.label === "modern crop_image bad area")?.full ?? "");
console.log(
  `${rejected ? "ok    " : "FAIL  "} crop_image refuses a Subject Area outside the frame`,
);

const hung = probes.filter((p) => p.bodyMs === null);
console.log(
  `\n${String(probes.length)} exchanges probed, ${String(hung.length)} never closed ` +
    `within ${String(BUDGET_MS)}ms`,
);
if (hung.length > 0 || !advertised || !rejected) process.exitCode = 1;
