import { Hono } from "hono";
import type { Records } from "@meco/records";
import { RECORDS_UNCONFIGURED, reachRecords } from "@meco/records/health";
import type { Store } from "@meco/store";
import { reachStores } from "@meco/store/health";
import { webui } from "@meco/webui";
import { callerLookup } from "./auth";
import { type Health, reachModels, version } from "./health";

export interface AppDependencies {
  /**
   * The database this process migrated at boot, or `null` when none is
   * configured. Handed in rather than opened here so that the process that
   * proved the schema is the process that serves it, and so a test builds an
   * app without ever holding a pool.
   */
  readonly records?: Records | null;
  /**
   * How the pages address the bytes they show. URLs only: the gateway hands
   * webui no way to read an object. `null` is a deployment whose `/ui` is not
   * mounted rather than one that renders cards with no image.
   */
  readonly store?: Pick<Store, "publicUrl" | "signedUrl"> | null;
}

export function createApp(dependencies: AppDependencies = {}): Hono {
  const app = new Hono();
  const { records = null, store = null } = dependencies;

  app.get("/health", async (c) => {
    const [models, storeReach, recordsReach] = await Promise.all([
      reachModels(),
      reachStores(),
      records === null ? RECORDS_UNCONFIGURED : reachRecords(records),
    ]);
    const body: Health = {
      ok: true,
      service: "gateway",
      version: version(),
      models,
      store: storeReach,
      records: recordsReach,
    };
    return c.json(body);
  });

  // The one door: webui is handed the gateway's own Caller lookup and never
  // reaches `callers.byKey` itself. Mounted only when both halves exist,
  // because a Gallery with no database and no URLs is a page that can only
  // fail.
  if (records !== null && store !== null) {
    app.route("/ui", webui({ records, store, caller: callerLookup(records) }));
  }

  return app;
}
