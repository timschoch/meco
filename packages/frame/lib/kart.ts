import type { Region, RegionKind } from "@meco/contracts";
import { regionWithLargestBox, overlapOfSmaller, union } from "./boxes";
import type { ComposedSubject } from "./framing";

/**
 * The Kinds this rung composes from: a kart and whoever is on it, and nothing
 * else the picture happens to hold.
 *
 * A face is deliberately not one of them. It is not part of "the kart and its
 * driver" — the driver's own `person` Region already is — and joining one
 * would let a spectator's face carry the union into the crowd on a photograph
 * where their body did not overlap the kart enough to, which is the failure
 * {@link KART_JOIN_OVERLAP} exists to prevent. Unreachable until #109
 * re-recorded the fixtures through the whole Catalogue, where every karting
 * photograph carries YuNet's faces beside D-FINE's boxes.
 */
const JOINABLE: RegionKind[] = ["person", "vehicle"];

/**
 * The share of the smaller of two boxes that must lie inside the other before
 * the kart rung joins them into one Subject.
 *
 * Re-affirmed against the shipped Catalogue — yunet@1, dfine@1, edgeface@1 —
 * on 6 September 2026, by `tests/record.ts` over the six karting recordings
 * under `tests/fixtures/`. Sweeping the threshold from 0.001 to 0.999, every
 * value in **0.156 to 0.271** composes all six of the Subjects a human
 * verified by rendering them over the photograph, and no value outside it
 * composes more than five. 0.25 is inside that band, so it stands.
 *
 * What that measurement cannot do is rank points inside the band. The verified
 * Subjects are themselves 0.25 unions, so every threshold composing the same
 * union scores the same and 0.20 is indistinguishable from 0.25 here. The
 * finding is the band's **edges** — where the union stops being the accepted
 * one — and the constant sits within them with room on both sides. Ranking
 * points would need photographs whose accepted framing was decided
 * independently of this rule.
 *
 * What the number does, unchanged from the prototype's Q11
 * (`docs/research/kart-and-driver-subjects.md`): take the kart box, add every
 * `person` or `vehicle` box overlapping it by more than a quarter of the
 * smaller box, and union them. That frames the kart and whoever is on it, and
 * it leaves the crowd out without any rule about crowds — a spectator does not
 * overlap a kart. Seeding on the largest box rather than the highest-scoring
 * one took the prototype's 32 photographs from 29 usable to 31 (Q12).
 *
 * The six are not the 32: only they carry a licence permitting a commit. The
 * band above is the narrower claim their number supports.
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
      (JOINABLE.includes(region.kind) &&
        overlapOfSmaller(region.box, seed.box) > KART_JOIN_OVERLAP)
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
