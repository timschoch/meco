// Entry point: the container's process. Applies the migrations, then binds the
// socket.
import { serve } from "@hono/node-server";
import { createApp } from "./lib/app";
import { CONNECTION_STRING_VAR, openRecords } from "./lib/records";

const port = Number(process.env["PORT"] ?? 80);

const records = openRecords();

if (records !== null) {
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
} else {
  console.log(
    `gateway has no records database: ${CONNECTION_STRING_VAR} is unset`
  );
}

serve({ fetch: createApp({ records }).fetch, port }, (info) => {
  console.log(`gateway listening on ${info.port}`);
});
