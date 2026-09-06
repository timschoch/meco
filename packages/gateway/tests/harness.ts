// What every gateway test builds on: the app over real modules, as the seam
// confirmed on #88 has it. records on PGlite, the in-memory store, and the
// real models client over a `fetch` that answers from committed fixtures, so
// no test reaches Neon, Blob or a model.
import { createHash } from "node:crypto";
import { records, type Records } from "@meco/records";
import { pgliteDatabase } from "@meco/records/pglite";
import { memoryStore, type Store } from "@meco/store";
import { createModelsClient, type ModelsClient } from "@meco/models";
import { createApp, type GatewayDeps } from "../app";
import modelsCatalogue from "./fixtures/models-catalogue.json";
import modelsHealth from "./fixtures/models-health.json";

/** Booting PGlite costs more than Vitest's default five seconds under `pnpm check`. */
export const TIMEOUT = 30_000;

export const KEY = "sk_test_the_bootstrap_key";
/** The Brands the seed writes; the test Caller holds the first two. */
export const BRANDS = [
  { id: "hopefamily", name: "Hope Family" },
  { id: "laica", name: "laica" },
  { id: "swisshutless", name: "Swiss Hutless" },
] as const;
export const HELD = ["laica", "hopefamily"] as const;
export const NOT_HELD = "swisshutless";

export const MODELS_URL = "http://models.internal";

export const basic = (user: string, key: string): string =>
  `Basic ${Buffer.from(`${user}:${key}`).toString("base64")}`;

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * models' wire from fixtures. `/health` and `/models` answer the committed
 * bodies; anything else is a 404 the client reports as `bad_response`. Every
 * call is counted, so a test can prove how often the gateway crossed it.
 */
export function fakeModels(options: { health?: unknown } = {}) {
  const seen: string[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    seen.push(`${request.method} ${pathname}`);
    if (pathname === "/health") {
      return Response.json(options.health ?? modelsHealth);
    }
    if (pathname === "/models") return Response.json(modelsCatalogue);
    return Response.json(
      { error: { code: "not_found", message: pathname } },
      { status: 404 }
    );
  };
  return { seen, fetch };
}

export interface Opened {
  readonly records: Records;
  readonly store: Store;
  readonly models: ModelsClient;
  readonly modelsSeen: string[];
  readonly deps: GatewayDeps;
  app(overrides?: Partial<GatewayDeps>): ReturnType<typeof createApp>;
  close(): Promise<void>;
}

/** A migrated, seeded stack. Callers close it; `tests/*.test.ts` do so in `afterEach`. */
export async function open(
  options: { models?: ReturnType<typeof fakeModels> } = {}
): Promise<Opened> {
  const store = memoryStore();
  const opened = records({ database: pgliteDatabase(), store });
  await opened.migrate();
  for (const brand of BRANDS) await opened.brands.ensure(brand);
  await opened.callers.create({ name: "test", key: KEY, brands: [...HELD] });

  const wire = options.models ?? fakeModels();
  const models = createModelsClient({ baseUrl: MODELS_URL, fetch: wire.fetch });
  const deps: GatewayDeps = { records: opened, store, models, version: "test" };
  return {
    records: opened,
    store,
    models,
    modelsSeen: wire.seen,
    deps,
    app: (overrides = {}) => createApp({ ...deps, ...overrides }),
    close: () => opened.close(),
  };
}

/** One JSON-RPC request to the MCP Door, as a client with a key would send it. */
export async function rpc(
  app: ReturnType<typeof createApp>,
  body: { method: string; params?: unknown },
  headers: Record<string, string> = { Authorization: `Bearer ${KEY}` }
): Promise<{ status: number; result?: unknown; error?: unknown }> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
  if (!res.ok) return { status: res.status, error: await res.text() };
  const text = await res.text();
  // The stateless transport answers a POST as JSON or as one SSE frame; the
  // message is the same either way.
  const json = res.headers.get("content-type")?.includes("text/event-stream")
    ? (text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim() ?? "")
    : text;
  const message = JSON.parse(json) as { result?: unknown; error?: unknown };
  return { status: res.status, result: message.result, error: message.error };
}
