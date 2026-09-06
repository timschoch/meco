import type { Region } from "@meco/contracts";
import { regionWithLargestBox, overlapOfSmaller, union } from "./boxes";
import type { ComposedSubject } from "./framing";

/**
 * The share of the smaller of two boxes that must lie inside the other before
 * the kart rung joins them into one Subject.
 *
 * Measured on 32 on-track karting photographs
 * (`docs/research/kart-and-driver-subjects.md`, Q11): take the kart box, add
 * every box overlapping it by more than 25 % of the smaller box, and union
 * them. That framed the kart and whoever is on it, and it left the crowd out
 * without any rule about crowds — a spectator does not overlap a kart. Seeding
 * on the largest box rather than the highest-scoring one then took the same 32
 * from 29 usable to 31, with nothing regressed (Q12).
 *
 * Re-measured against the `models` adapters on #109. Until then it is the
 * prototype's number, measured on the prototype's detections.
 */
const KART_JOIN_OVERLAP = 0.25;

/**
 * What the union is built around: the largest `vehicle` box, or the largest
 * `person` box when the photograph holds no vehicle.
 *
 * The largest box and not the highest score. On `podium-trophy.jpg` a press
 * photographer outscores the driver 0.9429 to 0.9401 while covering 0.2343 of
 * the frame against the driver's 0.3648, so seeding on the score would frame
 * the wrong person.
 *
 * The `person` fallback is what lets a driver be framed without their kart. It
 * is also this rung's known limit: on a photograph that is not of a kart at all
 * it frames the largest person and still calls itself `kart`.
 */
const seedRegion = (regions: Region[]): Region | undefined => {
  const vehicles = regions.filter((region) => region.kind === "vehicle");
  const pool =
    vehicles.length > 0
      ? vehicles
      : regions.filter((region) => region.kind === "person");

  return regionWithLargestBox(pool);
};

/**
 * The `kart` rung: one Subject holding a kart and its driver together.
 *
 * The Subject of a karting photograph is neither the kart nor the driver but
 * both — a frame on the driver's head loses the livery the photograph was taken
 * for, and a frame on the kart cuts the helmet off. A helmet is also not a
 * face, which is why this rung exists at all: measured on 32 on-track
 * photographs, the face detector puts a box on the leading driver's head in 9
 * of them.
 *
 * Selection is on Region Kind alone. Nothing here reads `Region.label`, so
 * replacing the Model that draws the boxes moves nothing in this file.
 */
export const kartSubject = (regions: Region[]): ComposedSubject | undefined => {
  const seed = seedRegion(regions);
  if (seed === undefined) return undefined;

  const joined = regions.filter(
    (region) =>
      region.id === seed.id ||
      overlapOfSmaller(region.box, seed.box) > KART_JOIN_OVERLAP
  );

  return {
    resolvedBy: "kart",
    leadRegionId: seed.id,
    // The seed is in `joined` already; naming it again is what tells the type
    // there is at least one box to union.
    subject: union(seed.box, ...joined.map((region) => region.box)),
    keptRegionIds: joined.map((region) => region.id),
  };
};
