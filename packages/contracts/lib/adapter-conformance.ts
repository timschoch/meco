import { deepStrictEqual } from "node:assert/strict";
import {
  AdapterRegionRules,
  hasFaceLandmarks,
  isUnitLength,
} from "./annotation";
import type { DecodedImage, ModelAdapter } from "./adapter";
import type { AdapterRegion } from "./region-ids";
import type { Check } from "./schema-conformance";

/** What an adapter author hands {@link adapterConformance}. */
export interface AdapterFixtures {
  /**
   * A decode of a real photograph holding what the adapter looks for. The
   * adapter's own host decodes it; contracts reads no file and no pixel.
   */
  image: DecodedImage;
  /** An image with nothing in it. A 4 by 4 mid-grey image is enough. */
  blank: DecodedImage;
}

/**
 * How far two runs' box, landmark and score values may drift apart: they are
 * rounded to this before they are compared. Never byte equality — an ONNX
 * runtime is free to give the last bits of a float differently between runs,
 * and a suite that called that a defect would be red for no reason.
 */
const ROUNDING = 1e-4;

/**
 * How alike two runs' Face Prints must be, as a cosine. Exported because
 * models' Enricher suite holds the same rule over the same vectors, and two
 * copies of a threshold are two thresholds.
 */
export const PRINT_COSINE = 0.9999;

const round = (value: number) => Math.round(value / ROUNDING) * ROUNDING;

/** Every number of one flat object rounded, the keys left alone. */
const rounded = <T extends Record<string, number>>(measured: T): T =>
  Object.fromEntries(
    Object.entries(measured).map(([key, value]) => [key, round(value)])
  ) as T;

/**
 * A Region as the determinism check compares it: every measured number
 * rounded, and the print's vector left out — vectors are compared by cosine,
 * where a rounding would be the wrong question to ask. Every other field is
 * spread through untouched, so a field added to the Region is compared here
 * without a second edit.
 */
const comparable = (region: AdapterRegion) => ({
  ...region,
  score: round(region.score),
  box: rounded(region.box),
  landmarks:
    region.landmarks &&
    Object.fromEntries(
      Object.entries(region.landmarks).map(([name, point]) => [
        name,
        rounded(point),
      ])
    ),
  facePrint: region.facePrint && { model: region.facePrint.model },
});

/** Cosine of two vectors. Two of different lengths are as unalike as can be. */
export const cosine = (a: number[], b: number[]): number => {
  if (a.length !== b.length) return -1;
  let dot = 0;
  let squaredA = 0;
  let squaredB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    squaredA += a[i]! * a[i]!;
    squaredB += b[i]! * b[i]!;
  }
  const scale = Math.sqrt(squaredA) * Math.sqrt(squaredB);
  return scale === 0 ? -1 : dot / scale;
};

/** Where a red run points: which region of which run broke which rule. */
const at = (index: number) => `region ${index}`;

/**
 * The Conformance Checks every Model Adapter passes, whatever it detects. An
 * adapter author runs them from their own Vitest file:
 *
 * ```ts
 * for (const check of adapterConformance(adapter, fixtures)) it(check.name, check.run);
 * ```
 *
 * Eight checks, always in this order, each named for the rule it holds so that
 * a red run says which rule broke. A check reports failure by throwing.
 */
export function adapterConformance(
  adapter: ModelAdapter,
  fixtures: AdapterFixtures
): Check[] {
  const found = () => adapter.run(fixtures.image);

  return [
    {
      name: "every region parses as an Adapter Region",
      async run() {
        (await found()).forEach((region, i) => {
          const result = AdapterRegionRules.safeParse(region);
          if (!result.success) {
            throw new Error(
              `${at(i)} is not an Adapter Region: ${result.error.message}`
            );
          }
        });
      },
    },
    {
      name: "every region carries the adapter's own model",
      async run() {
        (await found()).forEach((region, i) => {
          const { name, version } = adapter.model;
          if (region.model.name !== name || region.model.version !== version) {
            throw new Error(
              `${at(i)} is stamped ${region.model.name}@${region.model.version}, but the adapter declares ${name}@${version}`
            );
          }
        });
      },
    },
    {
      name: "every region's kind is one the adapter declares",
      async run() {
        (await found()).forEach((region, i) => {
          if (!adapter.kinds.includes(region.kind)) {
            throw new Error(
              `${at(i)} is a ${region.kind}, which the adapter does not declare: ${adapter.kinds.join(", ")}`
            );
          }
        });
      },
    },
    {
      name: "the licence text is not empty",
      async run() {
        if (adapter.licence.trim() === "") {
          throw new Error(
            "the adapter declares no licence text, so its Model may not ship"
          );
        }
      },
    },
    {
      name: "the same image twice gives the same regions",
      async run() {
        const first = await found();
        const second = await found();
        if (first.length !== second.length) {
          throw new Error(
            `the same image gave ${first.length} regions and then ${second.length}`
          );
        }
        first.forEach((region, i) => {
          const again = second[i]!;
          deepStrictEqual(
            comparable(again),
            comparable(region),
            `${at(i)} differs between two runs of the same image, past a rounding to ${ROUNDING}`
          );
          const before = region.facePrint?.vector;
          const after = again.facePrint?.vector;
          if (before && after) {
            const alike = cosine(before, after);
            if (alike < PRINT_COSINE) {
              throw new Error(
                `${at(i)}'s face print differs between two runs of the same image: cosine ${alike} is below ${PRINT_COSINE}`
              );
            }
          }
        });
      },
    },
    {
      name: "a blank image gives no regions and no throw",
      async run() {
        const regions = await adapter.run(fixtures.blank);
        if (regions.length !== 0) {
          throw new Error(
            `a blank image gave ${regions.length} regions, and nothing is there`
          );
        }
      },
    },
    {
      name: "every face region has landmarks",
      async run() {
        (await found()).forEach((region, i) => {
          if (!hasFaceLandmarks(region)) {
            throw new Error(`${at(i)} is a face and carries no landmarks`);
          }
        });
      },
    },
    {
      name: "every face print is unit length",
      async run() {
        (await found()).forEach((region, i) => {
          const print = region.facePrint;
          if (print && !isUnitLength(print.vector)) {
            throw new Error(
              `${at(i)}'s face print is ${Math.hypot(...print.vector)} long, and a print is unit length`
            );
          }
        });
      },
    },
  ];
}
