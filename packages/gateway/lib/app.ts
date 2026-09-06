import { Hono } from "hono";
import type { Records } from "@meco/records";
import { RECORDS_UNCONFIGURED, reachRecords } from "@meco/records/health";
import { reachStores } from "@meco/store/health";
import { type Health, reachModels, version } from "./health";

export interface AppDependencies {
  /**
   * The database this process migrated at boot, or `null` when none is
   * configured. Handed in rather than opened here so that the process that
   * proved the schema is the process that serves it, and so a test builds an
   * app without ever holding a pool.
   */
  readonly records?: Records | null;
}

export function createApp(dependencies: AppDependencies = {}): Hono {
  const app = new Hono();
  const { records = null } = dependencies;

  app.get("/health", async (c) => {
    const [models, store, recordsReach] = await Promise.all([
      reachModels(),
      reachStores(),
      records === null ? RECORDS_UNCONFIGURED : reachRecords(records),
    ]);
    const body: Health = {
      ok: true,
      service: "gateway",
      version: version(),
      models,
      store,
      records: recordsReach,
    };
    return c.json(body);
  });

  return app;
}
