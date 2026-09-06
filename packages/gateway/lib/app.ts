import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ModelsClient } from "@meco/models";
import type { Records } from "@meco/records";
import type { Store } from "@meco/store";
import { webui } from "@meco/webui";
import { callerLookup } from "./auth";
import { GatewayError, toWire } from "./errors";
import { healthProbe } from "./health";
import { type CallerEnv, httpDoor } from "./http";
import { mcpDoor } from "./mcp";
import { catalogueOf } from "./catalogue";
import { OPERATIONS } from "./operations";

export interface GatewayDeps {
  /**
   * The database this process migrated at boot. Handed in rather than opened
   * here so that the process that proved the schema is the process that
   * serves it, and so a test builds an app without ever holding a pool.
   */
  readonly records: Records;
  readonly store: Store;
  /**
   * The thin client over the service binding, or `null` when `MODELS_URL` is
   * not injected: `/health` then reports `models.bound: false` and the
   * pipeline answers `models_unavailable`.
   */
  readonly models: ModelsClient | null;
  /** Fetches a `{ url }` Source Reference. The global `fetch` by default. */
  readonly fetch?: typeof fetch;
  /** What `/health` and the MCP server report. */
  readonly version?: string;
  /** The clock `/health`'s cache and a Call's `startedAt` read. */
  now?(): Date;
}

export function createApp(deps: GatewayDeps): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  const {
    records,
    store,
    models,
    fetch = globalThis.fetch,
    version = "0.0.0",
    now = () => new Date(),
  } = deps;
  const caller = callerLookup(records);

  app.onError((error, c) => {
    const { status, body } = toWire(error);
    if (status === 500) console.error("gateway:", error);
    return c.json(body, status as ContentfulStatusCode);
  });
  // On the parent, because a mounted sub-app's `notFound` never runs: the
  // whole gateway answers an unknown path as the wire's error.
  app.notFound((c) => {
    const { status, body } = toWire(
      new GatewayError("not_found", `nothing answers ${c.req.path}`)
    );
    return c.json(body, status as ContentfulStatusCode);
  });

  const health = healthProbe({ records, models, version, now });
  app.get("/health", async (c) => c.json(await health()));

  // The Caller, once per request, on every route behind a Door. No browser
  // challenge here: an API client gets no prompt, and `/ui` sends its own.
  const requireCaller = createMiddleware<CallerEnv>(async (c, next) => {
    const found = await caller(c.req.raw);
    if (found === null) {
      throw new GatewayError("unauthorized", "no Caller holds this key");
    }
    c.set("caller", found);
    await next();
  });
  app.use("/v1/*", requireCaller);
  app.use("/mcp", requireCaller);

  const operationDeps = {
    records,
    store,
    models,
    fetch,
    catalogue: catalogueOf(models),
    now,
  };
  app.route("/v1", httpDoor(OPERATIONS, operationDeps));

  const mcp = mcpDoor(OPERATIONS, operationDeps, version);
  app.all("/mcp", (c) => mcp(c.req.raw, c.get("caller")));

  // The one door: webui is handed the gateway's own Caller lookup and never
  // reaches `callers.byKey` itself.
  app.route("/ui", webui({ records, store, caller }));

  return app;
}
