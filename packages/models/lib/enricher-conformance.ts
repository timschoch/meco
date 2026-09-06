import { deepStrictEqual } from "node:assert/strict";
import {
  type AdapterRegion,
  type DecodedImage,
  isUnitLength,
} from "@meco/contracts";
import { type Check, cosine, PRINT_COSINE } from "@meco/contracts/conformance";
import type { Enricher } from "./enricher";

/**
 * What an Enricher author hands {@link enricherConformance}. The Enricher's
 * own host decodes the photograph and runs the Detectors; nothing here reads a
 * file or a pixel, exactly as contracts' `AdapterFixtures` does not.
 */
export interface EnricherFixtures {
  /** The host's own decode of a real photograph holding what the Enricher serves. */
  image: DecodedImage;
  /**
   * The Regions a Detector found in `image`. At least one must be of the
   * served kind and servable, or the suite proves nothing and says so.
   */
  regions: AdapterRegion[];
  /** A Region of the served kind this Enricher cannot serve. */
  unservable: AdapterRegion;
  /** A Region of a kind this Enricher does not serve. */
  unserved: AdapterRegion;
}

/** Where a red run points: which region of which run broke which rule. */
const at = (index: number) => `region ${index}`;

/**
 * A Region as the checks compare it: everything the Enricher was not allowed
 * to touch. The print is left out because adding one is the whole job; every
 * other field is spread through, so a field added to the Region is compared
 * here without a second edit.
 */
const untouched = (region: AdapterRegion) => ({
  ...region,
  facePrint: undefined,
});

/**
 * The Conformance Checks every Enricher passes, whatever it adds. An Enricher
 * author runs them from their own Vitest file:
 *
 * ```ts
 * for (const check of enricherConformance(enricher, fixtures)) it(check.name, check.run);
 * ```
 *
 * Seven checks, always in this order, each named for the rule it holds so that
 * a red run says which rule broke. A check reports failure by throwing.
 * `docs/specs/models.md` names the mutation that turns each one red, and
 * `tests/enricher.test.ts` runs every one of them.
 */
export function enricherConformance(
  enricher: Enricher,
  fixtures: EnricherFixtures
): Check[] {
  const served = () => enricher.run(fixtures.image, fixtures.regions);

  // The unservable and the unserved Region sit in front of the Detector's own,
  // so an Enricher that answers with the ones it printed first is caught by
  // the order check rather than passing on a list that happens to line up.
  const mixedInput = (): AdapterRegion[] => [
    fixtures.unserved,
    fixtures.unservable,
    ...fixtures.regions,
  ];
  const mixed = () => enricher.run(fixtures.image, mixedInput());

  return [
    {
      name: "the same image and regions twice give the same face prints",
      async run() {
        const first = await served();
        const second = await served();
        const printed = first.filter((r) => r.facePrint).length;
        if (printed === 0) {
          throw new Error(
            "no region got a face print, so these fixtures prove nothing: `regions` must hold one the Enricher can serve"
          );
        }
        first.forEach((region, i) => {
          const before = region.facePrint?.vector;
          const after = second[i]?.facePrint?.vector;
          if (!before && !after) return;
          if (!before || !after) {
            throw new Error(
              `${at(i)} was printed on one run of the same image and not on the other`
            );
          }
          const alike = cosine(before, after);
          if (alike < PRINT_COSINE) {
            throw new Error(
              `${at(i)}'s face print differs between two runs of the same image: cosine ${alike} is below ${PRINT_COSINE}`
            );
          }
        });
      },
    },
    {
      name: "every face print carries the Enricher's own model",
      async run() {
        (await served()).forEach((region, i) => {
          const print = region.facePrint;
          if (!print) return;
          const { name, version } = enricher.model;
          if (print.model.name !== name || print.model.version !== version) {
            throw new Error(
              `${at(i)}'s face print is stamped ${print.model.name}@${print.model.version}, but the Enricher declares ${name}@${version}`
            );
          }
        });
      },
    },
    {
      name: "a region it cannot serve comes back unchanged and unprinted",
      async run() {
        const out = await mixed();
        const index = mixedInput().indexOf(fixtures.unservable);
        const region = out[index];
        if (!region) {
          throw new Error(
            "the region the Enricher could not serve was dropped, and redact still has to hide that face"
          );
        }
        deepStrictEqual(
          untouched(region),
          untouched(fixtures.unservable),
          `${at(index)} could not be served and came back changed`
        );
        if (region.facePrint) {
          throw new Error(
            `${at(index)} could not be served and still carries a face print`
          );
        }
      },
    },
    {
      name: "a region of a kind it does not serve is untouched",
      async run() {
        const out = await mixed();
        const index = mixedInput().indexOf(fixtures.unserved);
        const region = out[index];
        if (!region) {
          throw new Error(
            `a ${fixtures.unserved.kind} region was dropped by an Enricher that only serves ${enricher.on}`
          );
        }
        deepStrictEqual(
          region,
          fixtures.unserved,
          `${at(index)} is a ${fixtures.unserved.kind}, which an Enricher on ${enricher.on} may not touch`
        );
      },
    },
    {
      name: "the output holds the input's regions, in the input's order",
      async run() {
        const input = mixedInput();
        const out = await mixed();
        if (out.length !== input.length) {
          throw new Error(
            `${input.length} regions went in and ${out.length} came out; an Enricher adds to Regions and never adds or drops one`
          );
        }
        out.forEach((region, i) => {
          deepStrictEqual(
            untouched(region),
            untouched(input[i]!),
            `${at(i)} is not the region that went in at that position`
          );
        });
      },
    },
    {
      name: "every face print is unit length",
      async run() {
        (await served()).forEach((region, i) => {
          const print = region.facePrint;
          if (print && !isUnitLength(print.vector)) {
            throw new Error(
              `${at(i)}'s face print is ${Math.hypot(...print.vector)} long, and a print is unit length`
            );
          }
        });
      },
    },
    {
      name: "the licence text is not empty",
      async run() {
        if (enricher.licence.trim() === "") {
          throw new Error(
            "the Enricher declares no licence text, so its Model may not ship"
          );
        }
      },
    },
  ];
}
