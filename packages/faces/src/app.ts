/**
 * The meco-faces HTTP API.
 *
 * Deliberately tiny, and deliberately not public: meco is the only caller.
 * Face ML lives here rather than inside meco because ONNX Runtime and its model
 * files are a large, slow-booting dependency that nothing else in meco needs,
 * and because a service that only ever sees bytes and returns geometry can be
 * swapped for a different detector without touching the API anyone uses.
 *
 * Stateless: no storage, no database, and no secret but the shared token.
 *
 * The app is built by a function rather than at module scope so a test can hold
 * one with a known token and drive it through `app.fetch` — no port, no
 * container. `server.ts` is the only thing that ever listens.
 */
import { Hono, type Context, type Next } from "hono";

import { MODEL, ModelLoadError, detectFaces, isLoaded, runtimeVersion } from "./detect.js";

export function createFacesApp(token = process.env.MECO_TOKEN): Hono {
  const routes = new Hono();

  /**
   * The same bearer check meco runs, against the same `MECO_TOKEN`.
   *
   * Copied rather than shared. The two services are separate images with
   * separate dependency trees, and eight lines is a cheaper price than a
   * package that exists only to hold them.
   *
   * `x-auth-token` is accepted alongside `Authorization` so that the two
   * services agree on what an authorised request looks like; meco needs the
   * second name because Claude Desktop reserves the first for its own OAuth
   * flow and greys it out in the connector dialog.
   */
  const requireToken = async (c: Context, next: Next) => {
    if (!token) return next();
    const bearer = c.req.header("authorization") === `Bearer ${token}`;
    const direct = c.req.header("x-auth-token") === token;
    if (!bearer && !direct) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  };

  routes.use("/detect", requireToken);

  /**
   * Which models are loaded and what is running them.
   *
   * Open, like meco's own `/health`: a liveness probe that needs a secret
   * cannot be used by the platform that has to decide whether the container is
   * alive. It reveals a model name and a version, and `/detect` — the route
   * that costs CPU — is the one behind the token.
   */
  routes.get("/health", (c) =>
    c.json({
      ok: true,
      models: [{ ...MODEL, warm: isLoaded() }],
      onnxruntime: runtimeVersion(),
    }),
  );

  /**
   * Detect faces in one image.
   *
   * The body is the image itself rather than multipart or JSON: the caller is
   * meco, the payload is always exactly one photo, and a 12 MP JPEG has no
   * business being base64-encoded on the way here.
   */
  routes.post("/detect", async (c) => {
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) {
      return c.json({ error: "Request body is empty — POST the image bytes." }, 400);
    }

    try {
      const started = performance.now();
      const result = await detectFaces(Buffer.from(body));
      const ms = performance.now() - started;
      console.log(
        `detect ${String(result.width)}x${String(result.height)} ` +
          `${String(result.faces.length)} faces ${ms.toFixed(0)}ms`,
      );
      return c.json(result);
    } catch (err) {
      // A model that will not load is this service's fault, not the caller's,
      // and answering 400 would send them off looking at their own image.
      if (err instanceof ModelLoadError) {
        console.error(err.message);
        return c.json({ error: err.message }, 503);
      }
      // Everything else is a caller mistake — a body that is not an image.
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /**
   * Reachable at `/detect` and at `/faces/detect`.
   *
   * Vercel routes the two container services of this project by rewrite, and a
   * rewrite whose destination is a service passes the path through as it stands
   * — so a request the platform sent to `/faces/detect` arrives here still
   * wearing the prefix. Mounting the same routes twice means the container
   * answers the same way whether it is behind that rewrite, behind a second
   * project at its own domain, or running under plain `docker run`.
   */
  const app = new Hono();
  app.route("/", routes);
  app.route("/faces", routes);
  return app;
}
