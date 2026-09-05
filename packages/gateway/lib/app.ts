import { Hono } from "hono";
import { type Health, reachModels, reachStores, version } from "./health";

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
