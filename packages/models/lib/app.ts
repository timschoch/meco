import { createHash } from "node:crypto";
import { type Context, Hono } from "hono";
import {
  type AdapterRegion,
  ANNOTATION_SCHEMA,
  Annotation,
  assignRegionIds,
} from "@meco/contracts";
import { readBody } from "./body";
import { decode } from "./decode";
import type { Catalogue, Detector } from "./detector";
import { HostError } from "./errors";
import { type Health, version } from "./health";
import { Laps } from "./timing";

/** One Catalogue entry as `GET /models` lists it. */
export type CatalogueEntry = {
  readonly name: string;
  readonly version: string;
  readonly kinds: readonly string[];
  /** The licence id. The text is in the repository and the image. */
  readonly licence: string;
  readonly warm: boolean;
};

/**
 * Which Detectors a request names, in Catalogue order. Absent runs every
 * entry; present runs exactly those. A name not in the Catalogue is refused
 * and nothing is fetched.
 */
function selectModels(
  catalogue: Catalogue,
  query: string | undefined
): Detector[] {
  if (query === undefined) return [...catalogue.detectors];

  const names = query.split(",").map((name) => name.trim());
  if (names.length === 0 || names.includes("")) {
    throw new HostError("bad_models", "`models` must name at least one Model");
  }
  if (new Set(names).size !== names.length) {
    throw new HostError(
      "bad_models",
      `\`models\` names a Model twice: ${query}`
    );
  }
  for (const name of names) {
    if (!catalogue.detectors.some((d) => d.model.name === name)) {
      throw new HostError(
        "unknown_model",
        `no Model named ${name} is in the Catalogue`
      );
    }
  }
  return catalogue.detectors.filter((d) => names.includes(d.model.name));
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The wire's error body for anything thrown; an unknown throw is `internal`. */
function refuse(c: Context, err: unknown): Response {
  const error =
    err instanceof HostError
      ? err
      : new HostError("internal", "the host failed", { cause: err });
  if (error.code === "internal" || error.code === "model_unavailable") {
    console.error(`${error.code}: ${error.message}`, error.cause ?? "");
  }
  return c.json(
    { error: { code: error.code, message: error.message } },
    error.status as 400
  );
}

/**
 * The HTTP surface, built from a Catalogue so a test can hand in in-memory
 * Detectors. Without a socket: `server.ts` binds one.
 */
export function createApp(catalogue: Catalogue): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    const body: Health = {
      ok: true,
      service: "models",
      version: version(),
      models: catalogue.detectors.map((d) => ({
        ...d.model,
        warm: d.isWarm(),
      })),
      onnxruntime: catalogue.onnxruntime,
      rss: process.memoryUsage().rss,
    };
    return c.json(body);
  });

  app.get("/models", (c) => {
    const body: CatalogueEntry[] = catalogue.detectors.map((d) => ({
      name: d.model.name,
      version: d.model.version,
      kinds: d.kinds,
      licence: d.licenceId,
      warm: d.isWarm(),
    }));
    return c.json(body);
  });

  app.post("/annotate", async (c) => {
    try {
      const chosen = selectModels(catalogue, c.req.query("models"));
      const bytes = await readBody(c.req.raw);
      if (bytes.byteLength === 0) {
        throw new HostError("empty_body", "POST the image bytes as the body");
      }
      // The hash of the body as received, before anything touches it.
      const hash = sha256(bytes);

      const laps = new Laps();
      const { image, width, height, mime } = await decode(bytes);
      laps.lap("decode");

      const regions: AdapterRegion[] = [];
      for (const detector of chosen) {
        regions.push(...(await detector.run(image)));
        laps.lap(detector.model.name);
      }

      // Parsed before it leaves: an Annotation the host cannot vouch for is a
      // 500 here, never a corrupt entry in a cache that lives forever.
      const annotation = Annotation.parse({
        schema: ANNOTATION_SCHEMA,
        hash,
        mime,
        width,
        height,
        producedBy: chosen.map((d) => d.model),
        regions: assignRegionIds(regions),
      });

      console.log(
        `annotate ${mime} ${width}x${height} ${annotation.regions.length} regions ${laps.summary()}`
      );
      c.header("Server-Timing", laps.serverTiming());
      return c.json(annotation);
    } catch (err) {
      return refuse(c, err);
    }
  });

  return app;
}
