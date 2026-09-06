import { createHash } from "node:crypto";
import { type Context, Hono } from "hono";
import {
  type AdapterRegion,
  ANNOTATION_SCHEMA,
  Annotation,
  assignRegionIds,
  type ModelId,
  type RegionKind,
} from "@meco/contracts";
import { readBody } from "./body";
import { decode } from "./decode";
import type { Catalogue, Detector } from "./detector";
import type { Enricher } from "./enricher";
import { HostError } from "./errors";
import { type Health, version } from "./health";
import { Laps } from "./timing";

/** One Catalogue entry as `GET /models` lists it. */
export type CatalogueEntry = ModelId & {
  /** The Kinds it draws. Empty for an Enricher: it draws no Region of its own. */
  readonly kinds: readonly RegionKind[];
  /** The licence id. The text is in the repository and the image. */
  readonly licence: string;
  readonly warm: boolean;
};

/** The two roles, of the whole Catalogue or of what a request selected. */
interface Roles {
  readonly detectors: readonly Detector[];
  readonly enrichers: readonly Enricher[];
}

/** Both roles as one list, in the order they run, warm and are listed. */
const entries = (roles: Roles) => [...roles.detectors, ...roles.enrichers];

/**
 * Which Catalogue entries a request names, in Catalogue order. Absent runs
 * every entry; present runs exactly those. A name not in the Catalogue is
 * refused and nothing is fetched. An Enricher named without the Detector whose
 * kind it serves runs and enriches nothing: the Detector is never implied,
 * because that would hide a cost the caller did not ask for.
 */
function selectModels(catalogue: Catalogue, query: string | undefined): Roles {
  if (query === undefined) {
    return {
      detectors: [...catalogue.detectors],
      enrichers: [...catalogue.enrichers],
    };
  }

  // `"".split(",")` is `[""]`, so an empty value lands here too.
  const names = query.split(",").map((name) => name.trim());
  if (names.includes("")) {
    throw new HostError("bad_models", "`models` must name at least one Model");
  }
  if (new Set(names).size !== names.length) {
    throw new HostError(
      "bad_models",
      `\`models\` names a Model twice: ${query}`
    );
  }
  for (const name of names) {
    if (!entries(catalogue).some((m) => m.model.name === name)) {
      throw new HostError(
        "unknown_model",
        `no Model named ${name} is in the Catalogue`
      );
    }
  }
  return {
    detectors: catalogue.detectors.filter((d) => names.includes(d.model.name)),
    enrichers: catalogue.enrichers.filter((e) => names.includes(e.model.name)),
  };
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * The wire's error body for anything thrown; an unknown throw is `internal`.
 * The stages that did finish are still timed, so a slow decode that ends in a
 * refusal is visible where a success would be.
 */
function refuse(c: Context, err: unknown, laps: Laps): Response {
  const error =
    err instanceof HostError
      ? err
      : new HostError("internal", "the host failed", { cause: err });
  console.log(`annotate refused ${error.code} ${laps.summary()}`.trimEnd());
  if (error.code === "internal" || error.code === "model_unavailable") {
    console.error(`${error.code}: ${error.message}`, error.cause ?? "");
  }
  c.header("Server-Timing", laps.serverTiming());
  return c.json(
    { error: { code: error.code, message: error.message } },
    error.status
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
      models: entries(catalogue).map((m) => ({
        ...m.model,
        warm: m.isWarm(),
      })),
      onnxruntime: catalogue.onnxruntime,
      rss: process.memoryUsage().rss,
    };
    return c.json(body);
  });

  app.get("/models", (c) => {
    const body: CatalogueEntry[] = [
      ...catalogue.detectors.map((d) => ({
        ...d.model,
        kinds: d.kinds,
        licence: d.licenceId,
        warm: d.isWarm(),
      })),
      // An Enricher draws no Region of its own, so it lists no Kind.
      ...catalogue.enrichers.map((e) => ({
        ...e.model,
        kinds: [],
        licence: e.licenceId,
        warm: e.isWarm(),
      })),
    ];
    return c.json(body);
  });

  app.post("/annotate", async (c) => {
    const laps = new Laps();
    try {
      const chosen = selectModels(catalogue, c.req.query("models"));
      const bytes = await readBody(c.req.raw);
      if (bytes.byteLength === 0) {
        throw new HostError("empty_body", "POST the image bytes as the body");
      }
      // The hash of the body as received, before anything touches it.
      const hash = sha256(bytes);

      laps.start();
      const { image, width, height, mime } = await decode(bytes);
      laps.lap("decode");

      // Two stages: Detectors draw Regions from the one Decoded Image, then
      // Enrichers walk the union and hand it back with more on it.
      let regions: AdapterRegion[] = [];
      for (const detector of chosen.detectors) {
        regions.push(...(await detector.run(image)));
        laps.lap(detector.model.name);
      }
      for (const enricher of chosen.enrichers) {
        regions = await enricher.run(image, regions);
        laps.lap(enricher.model.name);
      }

      // Parsed before it leaves: an Annotation the host cannot vouch for is a
      // 500 here, never a corrupt entry in a cache that lives forever.
      const annotation = Annotation.parse({
        schema: ANNOTATION_SCHEMA,
        hash,
        mime,
        width,
        height,
        producedBy: entries(chosen).map((m) => m.model),
        regions: assignRegionIds(regions),
      });

      console.log(
        `annotate ${mime} ${width}x${height} ${annotation.regions.length} regions ${laps.summary()}`
      );
      c.header("Server-Timing", laps.serverTiming());
      return c.json(annotation);
    } catch (err) {
      return refuse(c, err, laps);
    }
  });

  return app;
}
