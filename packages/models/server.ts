// Entry point: the container's process. Binds the socket and nothing else.
import { serve } from "@hono/node-server";
import { createApp } from "./lib/app";

const port = Number(process.env["PORT"] ?? 80);

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`models listening on ${info.port}`);
});
