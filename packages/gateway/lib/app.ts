import { Hono } from "hono";
import { type Health, reachModels, version } from "./health";

export function createApp(): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    const body: Health = {
      ok: true,
      service: "gateway",
      version: version(),
      models: await reachModels(),
    };
    return c.json(body);
  });

  return app;
}
