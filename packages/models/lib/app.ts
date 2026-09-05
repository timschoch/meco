import { Hono } from "hono";
import { type Health, version } from "./health";

export function createApp(): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    const body: Health = { ok: true, service: "models", version: version() };
    return c.json(body);
  });

  return app;
}
