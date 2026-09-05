// In-memory Model Adapters for the adapter Conformance Checks. Private to
// tests/ by the boundary rules. No pixels are looked at beyond telling a flat
// image from a patterned one: contracts owns no model and decodes nothing.
import type {
  AdapterRegion,
  DecodedImage,
  ModelAdapter,
  RegionKind,
} from "../index";
import { unitVector } from "./samples";

/** The Model the passing fake declares, and stamps on every Region it draws. */
const model = { name: "fake-detector", version: "1" };

/** A second Model: the print comes from another network than the box. */
const printer = { name: "fake-printer", version: "1" };

const LICENCE = "Fake licence text. For the contracts tests only.";

const KINDS: RegionKind[] = ["face", "vehicle"];

/**
 * An image with nothing in it: 4 by 4 mid-grey, the fixture the spec names.
 * Built here rather than read from disk — no contracts test touches a file.
 */
export const blankImage = (): DecodedImage => ({
  width: 4,
  height: 4,
  channels: 3,
  data: new Uint8Array(4 * 4 * 3).fill(128),
});

/**
 * The stand-in for a decoded photograph. Its bytes vary, which is the only
 * property a fake reads: a real adapter runs a network over exactly this shape.
 */
export const patternImage = (): DecodedImage => {
  const data = new Uint8Array(8 * 8 * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 256;
  return { width: 8, height: 8, channels: 3, data };
};

/** Nothing to find in a flat image. How every fake below decides its answer. */
const isFlat = (image: DecodedImage) =>
  image.data.every((byte) => byte === image.data[0]);

const point = (x: number, y: number) => ({ x, y });

/** One face Region with its landmarks and its print, as a detector answers it. */
const face = (): AdapterRegion => ({
  kind: "face",
  label: "face",
  box: { x: 0.42, y: 0.18, width: 0.12, height: 0.16 },
  score: 0.97,
  model,
  landmarks: {
    rEye: point(0.45, 0.23),
    lEye: point(0.51, 0.23),
    nose: point(0.48, 0.26),
    rMouth: point(0.46, 0.29),
    lMouth: point(0.5, 0.29),
  },
  facePrint: { model: printer, vector: unitVector(1) },
});

/** One vehicle Region: a kind with neither landmarks nor a print. */
const vehicle = (): AdapterRegion => ({
  kind: "vehicle",
  label: "motorbike",
  box: { x: 0.3, y: 0.4, width: 0.4, height: 0.5 },
  score: 0.89,
  model,
});

/**
 * Builds an adapter from what it declares and what it answers. Every fake
 * below differs from {@link passingAdapter} in one thing and nothing else, so
 * a check that goes red names a defect and not a fixture.
 */
const adapterThat = (
  found: (image: DecodedImage) => AdapterRegion[],
  declared: Partial<Pick<ModelAdapter, "model" | "licence" | "kinds">> = {}
): ModelAdapter => ({
  model,
  licence: LICENCE,
  kinds: KINDS,
  ...declared,
  async run(image) {
    return isFlat(image) ? [] : found(image);
  },
});

/** The adapter every check must accept. */
export const passingAdapter: ModelAdapter = adapterThat(() => [
  face(),
  vehicle(),
]);

/** A broken fake with the one check name it must be rejected by. */
export interface BrokenAdapter {
  /** What is wrong with it. */
  defect: string;
  /** The exact `Check.name` that must reject it — and no other check may. */
  check: string;
  adapter: ModelAdapter;
}

/**
 * One broken fake per Conformance Check, in the order the checks run. Each
 * fails exactly the check it is paired with: that is what the suite asserts,
 * and it is what makes a red run point at a rule rather than at a fixture.
 */
export const brokenAdapters: BrokenAdapter[] = [
  {
    defect: "a box whose width is above 1",
    check: "every region parses as an Adapter Region",
    adapter: adapterThat(() => [
      { ...face(), box: { x: 0.42, y: 0.18, width: 1.5, height: 0.16 } },
    ]),
  },
  {
    defect: "a region stamped with another version of the Model",
    check: "every region carries the adapter's own model",
    adapter: adapterThat(() => [
      { ...face(), model: { ...model, version: "2" } },
    ]),
  },
  {
    defect: "a person region from an adapter declaring face and vehicle",
    check: "every region's kind is one the adapter declares",
    adapter: adapterThat(() => [
      { ...vehicle(), kind: "person", label: "person" },
    ]),
  },
  {
    defect: "an empty licence",
    check: "the licence text is not empty",
    adapter: adapterThat(() => [face(), vehicle()], { licence: "" }),
  },
  {
    defect: "a print that is a fresh unit vector on every run",
    check: "the same image twice gives the same regions",
    adapter: (() => {
      let run = 0;
      return adapterThat(() => [
        {
          ...face(),
          facePrint: { model: printer, vector: unitVector(++run) },
        },
      ]);
    })(),
  },
  {
    defect: "a throw when nothing is found",
    check: "a blank image gives no regions and no throw",
    adapter: {
      model,
      licence: LICENCE,
      kinds: KINDS,
      async run(image) {
        if (isFlat(image)) throw new Error("no regions found");
        return [face(), vehicle()];
      },
    },
  },
  {
    defect: "a face without landmarks",
    check: "every face region has landmarks",
    adapter: adapterThat(() => [{ ...face(), landmarks: undefined }]),
  },
  {
    defect: "an un-normalised print vector",
    check: "every face print is unit length",
    adapter: adapterThat(() => [
      { ...face(), facePrint: { model: printer, vector: [0.6, 0.8, 0.1] } },
    ]),
  },
];

/**
 * A print on a Region that is not a face. Its own fake beside the eight: the
 * rule has no Conformance Check named for it, so the check that parses a
 * Region is the one that must catch it.
 */
export const printOnAVehicleAdapter: ModelAdapter = adapterThat(() => [
  { ...vehicle(), facePrint: { model: printer, vector: unitVector(1) } },
]);

/** The same face with its box nudged by `drift` on every run after the first. */
const driftingBy = (drift: number): ModelAdapter => {
  let run = 0;
  return adapterThat(() => {
    const nudge = drift * run++;
    const drawn = face();
    return [{ ...drawn, box: { ...drawn.box, x: drawn.box.x + nudge } }];
  });
};

/** A box that drifts by ten times the tolerance. Two runs are not the same. */
export const driftingAdapter = driftingBy(1e-3);

/**
 * A box that drifts by a millionth of the tolerance: the last bits of a float,
 * which an ONNX runtime is free to give differently. Every check accepts it —
 * the determinism check is to tolerance and never byte equality.
 */
export const jitteryAdapter = driftingBy(1e-10);

/**
 * A second way to break determinism: the same Regions in a different order.
 * The spec names shuffling and noise as one check, so this is proof beside the
 * eight, not a ninth check.
 */
export const shufflingAdapter: ModelAdapter = (() => {
  let run = 0;
  return adapterThat(() =>
    ++run % 2 === 0 ? [vehicle(), face()] : [face(), vehicle()]
  );
})();
