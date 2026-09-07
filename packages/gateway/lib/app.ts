import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Template } from "@meco/compose/template";
import { identify } from "@meco/identify";
import type { ModelsClient } from "@meco/models";
import type { Records } from "@meco/records";
import type { Store } from "@meco/store";
import { webui } from "@meco/webui";
import { callerLookup } from "./auth";
import { GatewayError, toWire } from "./errors";
import { healthProbe } from "./health";
import { type CallerEnv, httpDoor } from "./http";
import { internalRoutes } from "./internal";
import { mcpDoor } from "./mcp";
import { catalogueOf, modelsUnbound } from "./catalogue";
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
  /**
   * The Templates the gateway plans, draws and lists. Absent means compose's
   * own, which is what the deployment runs on. Handed in only by a caller
   * that registered its own (#65) — and by the suite, which needs a Template
   * declaring a redaction default without shipping one nobody asked for.
   *
   * One registry for all three: a catalogue that listed Templates the paint
   * could not draw would be a catalogue lying about what a Brand offers.
   */
  readonly templates?: ReadonlyMap<string, Template>;
  /**
   * `CRON_SECRET`, the only key `/internal/*` answers to. Absent or empty and
   * those routes are never registered, so `/internal/sweep` is a `404`.
   */
  readonly cronSecret?: string;
  /** What `/health` and the MCP server report. */
  readonly version?: string;
  /**
   * The clock `/health`'s cache and a Call's `startedAt` read, and the one
   * the Sweep measures the Retention Window from. One clock, so a check can
   * move all three.
   */
  now?(): Date;
}

export function createApp(deps: GatewayDeps): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  const {
    records,
    store,
    models,
    fetch = globalThis.fetch,
    templates,
    cronSecret,
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

  // The cron's door, mounted only when there is a secret to check against.
  // Above the Caller middleware and outside it: `/internal/*` never looks a
  // Caller up.
  if (cronSecret !== undefined && cronSecret !== "") {
    app.route("/internal", internalRoutes({ records, cronSecret, now }));
  }

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
    // Built here, not handed in: identify is pure over records, the store and
    // one Annotator, so a caller of `createApp` that had to construct it would
    // be spelling out a wiring only this file can get wrong.
    identify: identify({
      records,
      store,
      // Passed straight through: identify's `AnnotateSource` and the models
      // client's are the same two shapes, and identify chooses which it sends.
      annotate: async (source, options) => {
        if (models === null) throw modelsUnbound();
        return models.annotate(source, options);
      },
    }),
    fetch,
    templates,
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
