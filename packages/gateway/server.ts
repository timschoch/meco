// Entry point: the container's process. Reads the environment into the app's
// dependencies, applies the migrations, then binds the socket.
import { serve } from "@hono/node-server";
import { createModelsClient } from "@meco/models";
import { blobStore } from "@meco/store";
import { createApp } from "./lib/app";
import { CONNECTION_STRING_VAR, openRecords } from "./lib/records";

const env = process.env;
const port = Number(env["PORT"] ?? 80);

const records = openRecords(env);
if (records === null) {
  // No database is no door: every Operation starts with `callers.byKey`.
  console.error(`gateway cannot start: ${CONNECTION_STRING_VAR} is unset`);
  process.exit(1);
}

// A failed migration is a failed boot, loudly. Vercel builds and promotes on
// push with no step we own in between, so the image and the schema it needs
// land together or not at all — a container that served requests against a
// schema it could not apply would be the failure nobody sees.
try {
  const { applied } = await records.migrate();
  console.log(`gateway applied ${applied} records migration(s)`);
} catch (error) {
  console.error("gateway could not apply the records migrations", error);
  process.exit(1);
}

const modelsUrl = env["MODELS_URL"];
const models =
  modelsUrl === undefined || modelsUrl === ""
    ? null
    : createModelsClient({ baseUrl: modelsUrl });

const app = createApp({
  records,
  store: blobStore(),
  models,
  version: env["VERCEL_GIT_COMMIT_SHA"] ?? env["MECO_VERSION"] ?? "0.0.0",
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`gateway listening on ${info.port}`);
});
