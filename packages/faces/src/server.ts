/**
 * The listener for meco-faces. Everything it serves is in `app.ts`.
 *
 * The model session is warmed here rather than on the first request: the
 * container scales to zero, so the first `/detect` after a boot would otherwise
 * pay for the ONNX session create as well as the inference. Warming in the
 * background lets the boot and the first request overlap instead.
 */
import { serve } from "@hono/node-server";

import { createFacesApp } from "./app.js";
import { MODEL, loadModel } from "./detect.js";

const app = createFacesApp();

// Vercel sets $PORT; 80 is the container-images default, as in meco.
const port = Number(process.env.PORT ?? 8788);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`meco-faces listening on :${String(info.port)}  model=${MODEL.file}`);
});

void loadModel()
  .then(() => {
    console.log(`${MODEL.name} loaded`);
  })
  .catch((err: unknown) => {
    // A model that cannot load makes every request fail, so say so loudly at
    // boot instead of once per request.
    console.error(`${MODEL.name} failed to load:`, err);
  });

export default app;
