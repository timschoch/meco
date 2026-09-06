// In-memory Detectors for the HTTP tests: what an adapter answers, without a
// network. Private to tests/ by the boundary rules.
import type { AdapterRegion, DecodedImage } from "@meco/contracts";
import { type Catalogue, type Detector, HostError } from "../catalogue";

const point = (x: number, y: number) => ({ x, y });

/** One face Region, as a detector answers it. */
export const fakeFace = (model: Detector["model"]): AdapterRegion => ({
  kind: "face",
  label: "face",
  box: { x: 0.4, y: 0.2, width: 0.1, height: 0.15 },
  score: 0.9,
  model,
  landmarks: {
    rEye: point(0.43, 0.25),
    lEye: point(0.47, 0.25),
    nose: point(0.45, 0.28),
    rMouth: point(0.44, 0.31),
    lMouth: point(0.46, 0.31),
  },
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

export const fakeCatalogue = (...detectors: Detector[]): Catalogue => ({
  detectors,
  onnxruntime: "0.0.0-fake",
});
