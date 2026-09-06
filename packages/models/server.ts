// Entry point: the container's process. Refuses a wrong runtime, binds the
// socket, then warms the Catalogue one Model after another.
import { serve } from "@hono/node-server";
import { createApp } from "./lib/app";
import { catalogue } from "./lib/catalogue";
import { assertRuntimeMajor } from "./lib/session";

assertRuntimeMajor();

const port = Number(process.env["PORT"] ?? 80);

serve({ fetch: createApp(catalogue).fetch, port }, (info) => {
  console.log(`models listening on ${info.port}`);
  void warm();
});

/**
 * Listen first, then warm: the socket answers `/health` while sessions are
 * created, and a request that arrives early waits on the same create.
 * Sequentially, in Catalogue order — every Detector, then every Enricher:
 * parallel creates compete for the one core
 * and cost the detector ~400 ms on a cold boot in the prototype. A Model that
 * fails to warm is logged and left to the next request's retry; it must not
 * stop the ones after it.
 */
async function warm(): Promise<void> {
  for (const entry of [...catalogue.detectors, ...catalogue.enrichers]) {
    const started = performance.now();
    try {
      await entry.warm();
      console.log(
        `${entry.model.name} warm in ${(performance.now() - started).toFixed(0)}ms`
      );
    } catch (err) {
      console.error(`${entry.model.name} failed to warm:`, err);
    }
  }
}
