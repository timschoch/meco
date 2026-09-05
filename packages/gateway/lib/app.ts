import { Hono } from "hono";
import { reachStores } from "@meco/store/health";
import { type Health, reachModels, version } from "./health";

export function createApp(): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    const [models, store] = await Promise.all([reachModels(), reachStores()]);
    const body: Health = {
      ok: true,
      service: "gateway",
      version: version(),
      models,
      store,
    };
    return c.json(body);
  });

  return app;
}
