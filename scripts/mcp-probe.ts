/**
 * Prove that an MCP exchange over `/mcp` ends.
 *
 * A response whose body never closes keeps the whole container alive until the
 * platform's max duration kills it — idle clients alone were costing hours of
 * runtime a day. Headers arriving quickly proves nothing: what matters is when
 * the *body* ends, so every probe reads the stream to completion under a clock.
 *
 * Drives the MCP handler in-process — no port, no container, no Vercel. Both
 * `/mcp` routes in `src/server.ts` hand the raw request straight to this
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
}

async function probe(
  label: string,
  body: { method: string },
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
        ...(modern ? { "mcp-method": body.method } : {}),
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
  { method, params }: { method: string; params: object },
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

for (const p of probes) {
  const body = p.bodyMs === null ? "NEVER CLOSED" : `${p.bodyMs.toFixed(0)}ms`;
  console.log(
    `${p.bodyMs === null ? "HANG  " : "ok    "} ${p.label.padEnd(24)} ` +
      `${String(p.status)}  headers=${p.headerMs.toFixed(0)}ms  body=${body}  ${p.contentType}` +
      `\n         ${p.body}`,
  );
}

const hung = probes.filter((p) => p.bodyMs === null);
console.log(
  `\n${String(probes.length)} exchanges probed, ${String(hung.length)} never closed ` +
    `within ${String(BUDGET_MS)}ms`,
);
if (hung.length > 0) process.exitCode = 1;
