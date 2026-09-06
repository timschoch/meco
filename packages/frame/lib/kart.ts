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
 * on 6 September 2026, by `tests/record.ts` over the four karting recordings
 * under `tests/fixtures/`. Sweeping the threshold from 0.001 to 0.999, every
 * value in **0.156 to 0.271** composes all four of the Subjects a human
 * verified by rendering them over the photograph, and no value outside it
 * composes more than three. 0.25 is inside that band, so it stands.
 *
 * Four and not the prototype's six: `podium-trophy.jpg` and
 * `podium-trophy-2.jpg` hold no `vehicle`, so this rung no longer composes
 * them. The band is unchanged by their leaving — neither ever bounded it.
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
 * The four are not the 32: only six of that set carry a licence permitting a
 * commit, and two of those hold no kart. The band above is the narrower claim
 * their number supports.
 */
const KART_JOIN_OVERLAP = 0.25;

/**
 * What the union is built around: the largest `vehicle` box. No vehicle, no
 * kart — the rung composes nothing and the ladder walks past it.
 *
 * The largest box and not the highest score. On `paddock-mixed.jpg`
 * `vehicle-2` outscores `vehicle-1` 0.4453 to 0.3451 while covering 0.0981 of
 * the frame against 0.1955, so seeding on the score would compose the union
 * around the wrong kart.
 *
 * It used to seed on the largest `person` when no vehicle was found, so a
 * driver could be framed without their kart. That fallback is deleted (#109).
 * It framed a body and still called the answer `kart`, and once `kart` moved
 * ahead of `face` in `DEFAULT_PIN_TO` it caught every portrait D-FINE draws a
 * body on: measured, five of the nine committed recordings, none of them
 * karting photographs. A rung that answers a photograph it is not about is
 * worse than a rung that declines.
 */
const seedRegion = (regions: Region[]): Region | undefined =>
  regionWithLargestBox(regions.filter((region) => region.kind === "vehicle"));

/**
 * The `kart` rung: one Subject holding a kart and its driver together.
 *
 * The Subject of a karting photograph is neither the kart nor the driver but
 * both — a frame on the driver's head loses the livery the photograph was taken
 * for, and a frame on the kart cuts the helmet off. The prototype's reason for
 * the rung was that its face detector missed the helmet: 9 boxes on the leading
 * driver's head across 32 on-track photographs. The shipped YuNet does not miss
 * it — 0.6488 through a dark visor, 0.8080 through an open one (#109) — so the
 * reason is now the first sentence and not the second, and it is why `kart`
 * precedes `face` in `DEFAULT_PIN_TO`.
 *
 * Selection is on Region Kind alone. Nothing here reads `Region.label`, so
 * replacing the Model that draws the boxes moves nothing in this file.
 */
export const kartSubject = (regions: Region[]): ComposedSubject | undefined => {
  const seed = seedRegion(regions);
  return seed === undefined ? undefined : kartAround(regions, seed, "kart");
};

/**
 * The kart around one named `vehicle`, rather than around the largest one.
 *
 * The `match` rung needs this when a number Match leads: identify has already
 * said which kart carries the Brand's number, and re-choosing by size here
 * would frame a different one. The union rule is the same rule — same Kinds,
 * same {@link KART_JOIN_OVERLAP} — because what "a kart and its driver" means
 * does not depend on why this kart was picked.
 *
 * `resolvedBy` is the caller's, so the `match` rung keeps saying `match`: how
 * the Subject was composed and which rung answered are two different facts.
 */
export const kartAround = (
  regions: Region[],
  seed: Region,
  resolvedBy: ComposedSubject["resolvedBy"]
): ComposedSubject => {
  const joined = regions.filter(
    (region) =>
      region.id === seed.id ||
      (JOINABLE.includes(region.kind) &&
        overlapOfSmaller(region.box, seed.box) > KART_JOIN_OVERLAP)
  );

  return {
    resolvedBy,
    leadRegionId: seed.id,
    // The seed is in `joined` already; naming it again is what tells the type
    // there is at least one box to union.
    subject: union(seed.box, ...joined.map((region) => region.box)),
    keptRegionIds: joined.map((region) => region.id),
  };
};
