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
import {
  EMBED_MODEL,
  EmbedModelLoadError,
  embedFaces,
  isEmbedLoaded,
  type FaceToEmbed,
} from "./embed.js";
import type { Landmarks } from "./yunet.js";

/**
 * Read the `faces` query parameter back into the shape `/detect` produced.
 *
 * Faces travel in the query string because the body is already spoken for by
 * the photograph, and a 12 MP JPEG has no business being wrapped in JSON so
 * that five points can ride along beside it.
 *
 * That does put a ceiling on how many faces one call can carry, and it is lower
 * than it looks. Measured on the four-face fixture: 632 encoded bytes per face
 * when the whole of `/detect`'s answer is passed through, 443 when only the
 * landmarks are — so Node's default 16 KB of request line and headers is reached
 * at roughly 25 faces, or 37 if the caller sends nothing but landmarks. Past
 * that the platform answers 431 before this code is ever reached, which is why
 * only `landmarks` is read: a caller with a crowd can drop everything else.
 *
 * Every field is checked rather than trusted. The alignment is pure arithmetic:
 * a missing landmark would not throw, it would produce a Face Print of
 * something that is not a face, and nothing downstream could tell.
 */
function parseFaces(raw: string | undefined): FaceToEmbed[] {
  if (raw === undefined) {
    throw new Error("Pass the faces from /detect as ?faces=<json>.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The faces parameter is not valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("The faces parameter must be an array, as /detect returns.");
  }

  const names = ["rEye", "lEye", "nose", "rMouth", "lMouth"] as const;
  return parsed.map((face, i) => {
    const marks = (face as { landmarks?: unknown }).landmarks;
    if (typeof marks !== "object" || marks === null) {
      throw new Error(`Face ${String(i)} has no landmarks.`);
    }
    for (const name of names) {
      const point = (marks as Record<string, unknown>)[name] as
        | { x?: unknown; y?: unknown }
        | undefined;
      if (typeof point?.x !== "number" || typeof point.y !== "number") {
        throw new Error(`Face ${String(i)} is missing the ${name} landmark.`);
      }
    }
    return { landmarks: marks as Landmarks };
  });
}

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
  routes.use("/embed", requireToken);

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
      models: [
        { ...MODEL, warm: isLoaded() },
        { ...EMBED_MODEL, warm: isEmbedLoaded() },
      ],
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
   * Turn faces already found in one image into Face Prints.
   *
   * Two calls rather than one route that detects and embeds together, because
   * meco does not want a Face Print for every face it finds: it caches an
   * Annotation per image and embeds only the faces a Person might be. The image
   * is sent twice in that case, which is a cost this service is happy to pay to
   * avoid running the expensive half on faces nobody asked about.
   *
   * The response keeps the caller's order, so `prints[i]` belongs to
   * `faces[i]`. No identity is returned or looked up — matching a Face Print to
   * a Person happens in meco, against a gallery this service cannot see.
   */
  routes.post("/embed", async (c) => {
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) {
      return c.json({ error: "Request body is empty — POST the image bytes." }, 400);
    }

    let faces: FaceToEmbed[];
    try {
      faces = parseFaces(c.req.query("faces"));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    try {
      const started = performance.now();
      const prints = await embedFaces(Buffer.from(body), faces);
      const ms = performance.now() - started;
      console.log(`embed ${String(prints.length)} faces ${ms.toFixed(0)}ms`);
      return c.json({ prints });
    } catch (err) {
      if (err instanceof EmbedModelLoadError) {
        console.error(err.message);
        return c.json({ error: err.message }, 503);
      }
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /**
   * Reachable at `/detect` and at `/faces/detect`, and the same for `/embed`.
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
