// What every gateway test builds on: the app over real modules, as the seam
// confirmed on #88 has it. records on PGlite, the in-memory store, and the
// real models client over a `fetch` that answers from committed fixtures, so
// no test reaches Neon, Blob or a model.
import { afterEach } from "vitest";
import { records, type Records } from "@meco/records";
import { pgliteDatabase } from "@meco/records/pglite";
import { memoryStore, type Store } from "@meco/store";
import { createModelsClient, type ModelsClient } from "@meco/models";
import { createApp, type GatewayDeps } from "../app";
import {
  FIXTURE_FILES,
  annotationByHash,
  fixtureBytes,
  sha256,
} from "./annotations";
import modelsCatalogue from "./fixtures/models-catalogue.json";
import modelsHealth from "./fixtures/models-health.json";

export { sha256 } from "./annotations";

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

/**
 * The cron's secret. Never in the default deps: a stack that was handed none
 * is what proves `/internal/*` does not exist without one.
 */
export const CRON_SECRET = "cron_test_the_sweep_secret";

export const basic = (user: string, key: string): string =>
  `Basic ${Buffer.from(`${user}:${key}`).toString("base64")}`;

/** What the fake host puts on `Server-Timing`: its own clock, as it would. */
export const SERVER_TIMING =
  "decode;dur=12.0, yunet;dur=43.6, dfine;dur=180.2, edgeface;dur=50.1";

/**
 * models' wire from fixtures. `/health` and `/models` answer the committed
 * bodies; `/annotate` answers the fixture Annotation whose bytes hash to the
 * body's sha256, or `undecodable` as the host would for bytes it cannot read;
 * anything else is a 404 the client reports as `bad_response`. Every call is
 * counted, so a test can prove how often the gateway crossed it.
 */
export function fakeModels(
  options: {
    health?: unknown;
    /** Answers `/annotate` instead of the fixtures, for an error a test wants. */
    annotate?: (request: Request) => Promise<Response>;
  } = {}
) {
  const seen: string[] = [];
  /** Every Signed URL the fake host was handed, so a test can read the key. */
  const fetched: string[] = [];
  /**
   * Where the fake host reads a `{ url }` body from: the same in-memory store
   * the gateway minted the Signed URL against, whose URLs are
   * `https://private.memory.store.invalid/<key>?validUntil=…`. Set by `open`.
   */
  let store: Store | undefined;

  const fetch = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    seen.push(`${request.method} ${pathname}`);
    if (pathname === "/health") {
      return Response.json(options.health ?? modelsHealth);
    }
    if (pathname === "/models") return Response.json(modelsCatalogue);
    if (pathname === "/annotate" && request.method === "POST") {
      if (options.annotate) return options.annotate(request);
      const body = await sourceBytes(request);
      if (body === null) {
        return Response.json(
          {
            error: {
              code: "source_unfetchable",
              message: "the Signed URL hands over nothing",
            },
          },
          { status: 502 }
        );
      }
      const annotation = annotationByHash(sha256(body));
      if (annotation === null) {
        return Response.json(
          { error: { code: "undecodable", message: "not a fixture" } },
          { status: 400 }
        );
      }
      return Response.json(annotation, {
        headers: { "server-timing": SERVER_TIMING },
      });
    }
    return Response.json(
      { error: { code: "not_found", message: pathname } },
      { status: 404 }
    );
  };

  /**
   * The photograph one `POST /annotate` names, whichever of the two carriers
   * it used: the bytes in the body, or the object a Signed URL hands over.
   * `null` when the URL names nothing the store holds, which is what an
   * expired or mistyped URL looks like from here.
   */
  async function sourceBytes(request: Request): Promise<Uint8Array | null> {
    const type = request.headers.get("content-type") ?? "";
    if (!type.startsWith("application/json")) {
      return new Uint8Array(await request.arrayBuffer());
    }
    const { url } = (await request.json()) as { url: string };
    fetched.push(url);
    const key = new URL(url).pathname.slice(1);
    return (await store?.get(key)) ?? null;
  }

  return {
    seen,
    fetched,
    fetch,
    /** The store the Signed URLs in a `{ url }` body are read from. */
    reads(from: Store) {
      store = from;
    },
  };
}

/** Where the fake photograph host serves the fixtures from. */
export const PHOTOS = "https://photos.test";

/**
 * The `fetch` the gateway resolves a `{ url }` Source Reference with: the
 * fixture photographs under `PHOTOS`, and 404 for any other path. A test that
 * wants a slow, oversized or refusing host hands `open` its own.
 */
export function fakePhotos() {
  const seen: string[] = [];
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    seen.push(url.href);
    init?.signal?.throwIfAborted();
    if (url.origin !== PHOTOS) return new Response("no such host", { status: 502 });
    const file = url.pathname.slice(1);
    if (!FIXTURE_FILES.includes(file)) {
      return new Response("no such photograph", { status: 404 });
    }
    return new Response(fixtureBytes(file), {
      headers: { "content-type": "image/jpeg" },
    });
  };
  return { seen, fetch };
}

export interface Opened {
  readonly records: Records;
  readonly store: Store;
  readonly models: ModelsClient;
  readonly modelsSeen: string[];
  /** Every Signed URL the gateway handed models in a `{ url }` body. */
  readonly modelsFetched: string[];
  /** Every URL the gateway fetched a Source Reference from. */
  readonly photosSeen: string[];
  readonly deps: GatewayDeps;
  app(overrides?: Partial<GatewayDeps>): ReturnType<typeof createApp>;
  close(): Promise<void>;
}

/** A migrated, seeded stack. Callers close it; `tests/*.test.ts` do so in `afterEach`. */
export async function open(
  options: {
    models?: ReturnType<typeof fakeModels>;
    photos?: ReturnType<typeof fakePhotos>;
  } = {}
): Promise<Opened> {
  const store = memoryStore();
  const opened = records({ database: pgliteDatabase(), store });
  await opened.migrate();
  for (const brand of BRANDS) await opened.brands.ensure(brand);
  await opened.callers.create({ name: "test", key: KEY, brands: [...HELD] });

  const wire = options.models ?? fakeModels();
  // The fake host fetches a `{ url }` body from the same store the gateway
  // minted the URL against, as the real one fetches from Blob.
  wire.reads(store);
  const photos = options.photos ?? fakePhotos();
  const models = createModelsClient({ baseUrl: MODELS_URL, fetch: wire.fetch });
  const deps: GatewayDeps = {
    records: opened,
    store,
    models,
    fetch: photos.fetch,
    version: "test",
  };
  return {
    records: opened,
    store,
    models,
    modelsSeen: wire.seen,
    modelsFetched: wire.fetched,
    photosSeen: photos.seen,
    deps,
    app: (overrides = {}) => createApp({ ...deps, ...overrides }),
    close: () => opened.close(),
  };
}

/**
 * What a test file needs: a `stack()` that opens one and an `afterEach` that
 * closes every one it opened. Called once at a file's top level.
 */
export function useStacks(): (
  ...args: Parameters<typeof open>
) => Promise<Opened> {
  const opened: Opened[] = [];
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((one) => one.close()));
  });
  return async (...args) => {
    const one = await open(...args);
    opened.push(one);
    return one;
  };
}

/**
 * The same Records with `people.list` watched, so a test can say whether a
 * module ran: the Brand Wall's proof is a module that must not have.
 */
export function watchingPeopleList(one: Opened): {
  records: Records;
  listed: string[];
} {
  const listed: string[] = [];
  return {
    listed,
    records: {
      ...one.records,
      people: {
        ...one.records.people,
        list: async (brand) => {
          listed.push(brand);
          return one.records.people.list(brand);
        },
      },
    },
  };
}

/**
 * The same Records with `sweep` counted, so a test can say whether the Sweep
 * ran at all and what clock it was handed. The route's whole job is to run it
 * exactly once, so counting is the assertion.
 */
export function countingSweep(one: Opened): {
  records: Records;
  swept: (Date | undefined)[];
} {
  const swept: (Date | undefined)[] = [];
  return {
    swept,
    records: {
      ...one.records,
      sweep: async (now) => {
        swept.push(now);
        return one.records.sweep(now);
      },
    },
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
