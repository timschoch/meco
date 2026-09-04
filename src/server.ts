/**
 * The meco container entry point.
 *
 * Everything the API does lives in `app.ts`; what is here is what only a real
 * process has — the Storage the environment implies, the local output directory
 * to serve, and the socket to listen on.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { createApp } from "./app.js";
import { createStorage } from "./storage.js";

const storage = createStorage();
const app = createApp(storage);

// Serve local renders so the URLs the local driver hands back actually resolve.
// Only mounted for local storage: on Blob the URLs point at Blob, and mounting
// these would just log a missing-directory warning on every request.
if (storage.kind === "local") {
  mkdirSync(resolve(process.cwd(), "out"), { recursive: true });
  app.use("/renders/*", serveStatic({ root: "./out" }));
  app.use("/carousels/*", serveStatic({ root: "./out" }));
  app.use("/crops/*", serveStatic({ root: "./out" }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`meco listening on :${info.port}  storage=${storage.kind}`);
});

export default app;
