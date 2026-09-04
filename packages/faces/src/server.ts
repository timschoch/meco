/**
 * The listener for meco-faces. Everything it serves is in `app.ts`.
 *
 * The model sessions are warmed here rather than on the first request: the
 * container scales to zero, so the first `/detect` after a boot would otherwise
 * pay for the ONNX session create as well as the inference. Warming in the
 * background lets the boot and the first request overlap instead.
 */
import { serve } from "@hono/node-server";

import { createFacesApp } from "./app.js";
import { MODEL, loadModel } from "./detect.js";
import { EMBED_MODEL, loadEmbedModel } from "./embed.js";

const app = createFacesApp();

// Vercel sets $PORT; 80 is the container-images default, as in meco.
const port = Number(process.env.PORT ?? 8788);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(
    `meco-faces listening on :${String(info.port)}  ` +
      `models=${MODEL.file},${EMBED_MODEL.file}`,
  );
});

// One after the other, detector first, and not both at once. The two creates
// compete for the same cores on a container sized for one, and starting them
// together costs the detector about 400 ms on a cold boot — paid by the request
// that woke the container, which is always a detection, because a caller cannot
// ask for a Face Print before it knows where the face is.
void (async () => {
  for (const [model, load] of [
    [MODEL, loadModel],
    [EMBED_MODEL, loadEmbedModel],
  ] as const) {
    try {
      await load();
      console.log(`${model.name} loaded`);
    } catch (err) {
      // A model that cannot load makes every request that needs it fail, so say
      // so loudly at boot instead of once per request — and carry on to the
      // next one, because a broken embedder must not stop the detector working.
      console.error(`${model.name} failed to load:`, err);
    }
  }
})();

export default app;
