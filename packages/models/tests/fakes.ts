// In-memory Detectors and Enrichers for the HTTP and conformance tests: what
// an adapter answers, without a network. Private to tests/ by the boundary
// rules.
import type { AdapterRegion, DecodedImage, ModelId } from "@meco/contracts";
import {
  type Catalogue,
  type Detector,
  type Enricher,
  HostError,
} from "../catalogue";

const point = (x: number, y: number) => ({ x, y });

/** One face Region, as a detector answers it. `at` slides it across the frame. */
export const fakeFace = (model: ModelId, at = 0): AdapterRegion => ({
  kind: "face",
  label: "face",
  box: { x: 0.4 + at, y: 0.2, width: 0.1, height: 0.15 },
  score: 0.9,
  model,
  landmarks: {
    rEye: point(0.43 + at, 0.25),
    lEye: point(0.47 + at, 0.25),
    nose: point(0.45 + at, 0.28),
    rMouth: point(0.44 + at, 0.31),
    lMouth: point(0.46 + at, 0.31),
  },
});

/** A Region of a kind no face Enricher serves. No landmarks, no print, ever. */
export const fakeVehicle = (model: ModelId): AdapterRegion => ({
  kind: "vehicle",
  label: "motorbike",
  box: { x: 0.1, y: 0.6, width: 0.3, height: 0.25 },
  score: 0.8,
  model,
});

/**
 * A Detector that answers what it is told and is Warm after `warm()`.
 * `warm` may be made to fail, which is how a test reaches `model_unavailable`.
 */
export function fakeDetector(
  name: string,
  options: {
    found?: (image: DecodedImage) => AdapterRegion[];
    warmFails?: boolean;
  } = {}
): Detector {
  const model = { name, version: "1" };
  let warm = false;
  const fail = () =>
    new HostError("model_unavailable", `${name} cannot create a session`);
  return {
    model,
    licence: `Fake licence for ${name}.`,
    licenceId: "Fake",
    kinds: ["face"],
    async warm() {
      if (options.warmFails) throw fail();
      warm = true;
    },
    isWarm: () => warm,
    async run(image) {
      if (options.warmFails) throw fail();
      warm = true;
      return options.found?.(image) ?? [fakeFace(model)];
    },
  };
}

/**
 * Every way an Enricher can break one of the seven rules, one flag each.
 * `tests/enricher.test.ts` pairs each with the check it must turn red; the
 * names are the mutations `docs/specs/models.md` lists beside the checks.
 */
export interface FakeEnricherFaults {
  /** A second run of the same input answers with another vector. */
  drift?: boolean;
  /** Stamp the print with a Model that is not the Enricher's own. */
  stamp?: ModelId;
  /** Drop a Region of the served kind it could not serve, instead of returning it. */
  dropRefused?: boolean;
  /** Put a print on a Region of a kind it does not serve. */
  touchUnserved?: boolean;
  /** Answer with the last two Regions the other way round. */
  reorder?: boolean;
  /** Skip the normalisation, so the vector is not unit length. */
  raw?: boolean;
  /** Ship this text as the licence instead of a real one. */
  licence?: string;
}

/** Length of a Face Print, as the real network fixes it. */
const PRINT_LENGTH = 512;

/**
 * An Enricher with no network: a Face Print derived from the Region's own box,
 * so two runs of one Region agree and two Regions differ. It refuses the same
 * face EdgeFace's warp refuses — five landmarks on one point, which no
 * similarity transform can be fitted to.
 */
export function fakeEnricher(
  model: ModelId,
  faults: FakeEnricherFaults = {}
): Enricher {
  let run = 0;
  let warm = false;

  const servable = (region: AdapterRegion): boolean => {
    const l = region.landmarks;
    if (!l) return false;
    const points = [l.rEye, l.lEye, l.nose, l.rMouth, l.lMouth];
    return points.some((p) => p.x !== l.rEye.x || p.y !== l.rEye.y);
  };

  const print = (region: AdapterRegion): number[] => {
    const seed = region.box.x + region.box.y + (faults.drift ? run : 0);
    const raw = Array.from(
      { length: PRINT_LENGTH },
      (_, i) => Math.sin((i + 1) * (seed + 1)) + 1.5
    );
    if (faults.raw) return raw;
    const norm = Math.hypot(...raw);
    return raw.map((v) => v / norm);
  };

  return {
    model,
    licence: faults.licence ?? `Fake licence for ${model.name}.`,
    licenceId: "Fake",
    on: "face",
    async warm() {
      warm = true;
    },
    isWarm: () => warm,

    async run(_image, regions) {
      run++;
      const printed = (region: AdapterRegion): AdapterRegion => ({
        ...region,
        facePrint: { model: faults.stamp ?? model, vector: print(region) },
      });

      const answered: AdapterRegion[] = [];
      for (const region of regions) {
        if (region.kind !== "face") {
          answered.push(faults.touchUnserved ? printed(region) : region);
        } else if (servable(region)) {
          answered.push(printed(region));
        } else if (!faults.dropRefused) {
          answered.push(region);
        }
      }
      if (faults.reorder && answered.length >= 2) {
        answered.push(...answered.splice(-2, 2).reverse());
      }
      return answered;
    },
  };
}

/**
 * A Catalogue of whatever adapters a test hands it, sorted into the two roles
 * by the one member that tells them apart.
 */
export const fakeCatalogue = (
  ...adapters: (Detector | Enricher)[]
): Catalogue => ({
  detectors: adapters.filter((a): a is Detector => !("on" in a)),
  enrichers: adapters.filter((a): a is Enricher => "on" in a),
  onnxruntime: "0.0.0-fake",
});
