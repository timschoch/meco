/**
 * The second Match Rule: a race number, read off a kart, found on the list of
 * numbers a Brand gave one of its People.
 *
 * It exists because a driver in a crash helmet has no face to compare. The
 * first rule can say nothing at all about them, and the number painted on the
 * kart is what a person standing at the fence reads instead.
 *
 * Two facts meet here and neither is enough alone. The Annotation says a
 * `number` Region carries the digits `24`, which is true of the bytes and
 * cached forever. The Brand says number `24` is this Person, which is true of
 * this Brand this season and is not about the bytes at all. The Match is where
 * they meet, which is why it is a Match and not something on the Annotation
 * (`CONTEXT.md`, Annotation).
 *
 * What the Match names is the **kart**, not the digits: a Crop of the number
 * plate alone would be a picture of nothing. The digits are named beside it as
 * `numberRegionId`, so a caller can say what was read and where.
 */
import type { Annotation, Box, Match, Region } from "@meco/contracts";
import type { PersonWithPrints } from "@meco/records";
import { NUMBER_ON_VEHICLE } from "./constants";
import { idNumber } from "./face";

/** The area of a Box, in the square of the frame. */
const area = (box: Box): number => box.width * box.height;

/**
 * How much of `inner` lies inside `outer`, as a share of `inner`. Not an IoU:
 * a number is a few hundredths of the frame and the kart it is painted on is
 * a fifth of it, so an intersection over the union of the two would be small
 * for the very pairing this rule is looking for.
 */
const shareInside = (inner: Box, outer: Box): number => {
  const width =
    Math.min(inner.x + inner.width, outer.x + outer.width) -
    Math.max(inner.x, outer.x);
  const height =
    Math.min(inner.y + inner.height, outer.y + outer.height) -
    Math.max(inner.y, outer.y);
  if (width <= 0 || height <= 0) return 0;
  return (width * height) / area(inner);
};

/**
 * The kart a number is painted on: the `vehicle` Region holding most of the
 * number's box, and holding more than {@link NUMBER_ON_VEHICLE} of it.
 *
 * **The tighter container wins a tie.** A photograph of a grid holds vehicle
 * boxes inside vehicle boxes — one detection over the whole row of karts, one
 * over the kart itself — and both contain the digits whole, at a share of 1.
 * The smaller box is the kart the number is actually on; the larger is the
 * row it stands in, and framing on it would frame the grid. Measured on
 * `fixtures/karts/kart-grid-24.jpg`, where the `21` sits inside three vehicle
 * boxes at a share of 1 and only the smallest of them is the #21 kart.
 *
 * No container above the floor is no Match. A number nothing is painted on has
 * no kart to frame, and answering with the number's own box would put a Crop
 * on the digits.
 */
const kartUnder = (
  numberBox: Box,
  vehicles: readonly Region[]
): Region | undefined => {
  let best: { region: Region; share: number } | undefined;
  for (const vehicle of vehicles) {
    const share = shareInside(numberBox, vehicle.box);
    if (share <= NUMBER_ON_VEHICLE) continue;
    if (best === undefined || share > best.share) {
      best = { region: vehicle, share };
      continue;
    }
    if (share < best.share) continue;
    // The tie, and then the tie of the tie: the smaller box, and failing that
    // the lower Region id, so the answer is one rectangle and not whichever
    // the array happened to hold first.
    const smaller = area(vehicle.box) - area(best.region.box);
    if (
      smaller < 0 ||
      (smaller === 0 && idNumber(vehicle.id) < idNumber(best.region.id))
    ) {
      best = { region: vehicle, share };
    }
  }
  return best?.region;
};

/**
 * Every number Match for one Annotation and one Brand.
 *
 * A number no Person carries is no Match — the picture is full of other
 * people's karts, and that is the common case. records keeps one number to one
 * Person within a Brand, so the lookup can never be ambiguous on its own side.
 *
 * The same number read twice on two karts gives that Person two Matches. Both
 * are reported: the picture really does hold two claims, and choosing between
 * them is framing's business and not identification's.
 */
export const numberMatches = (
  annotation: Annotation,
  brand: string,
  people: readonly PersonWithPrints[]
): Match[] => {
  const owner = new Map<string, string>();
  for (const person of people) {
    for (const number of person.numbers) owner.set(number, person.id);
  }
  if (owner.size === 0) return [];

  const vehicles = annotation.regions.filter(
    (region) => region.kind === "vehicle"
  );

  return annotation.regions
    .filter((region) => region.kind === "number")
    .sort((a, b) => idNumber(a.id) - idNumber(b.id))
    .flatMap((region) => {
      const personId = owner.get(region.label);
      if (personId === undefined) return [];
      const kart = kartUnder(region.box, vehicles);
      if (kart === undefined) return [];
      return [
        {
          regionId: kart.id,
          personId,
          brand,
          by: "number",
          numberRegionId: region.id,
        } satisfies Match,
      ];
    });
};
