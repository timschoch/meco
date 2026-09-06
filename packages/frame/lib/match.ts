import type { FramingRequest, Match, Region } from "@meco/contracts";
import type { ComposedSubject } from "./framing";
import { kartAround } from "./kart";
import { byRegionId } from "./tiers";

/**
 * The face Match that leads: the highest `similarity`, then the lowest Region
 * id.
 *
 * Similarity and not the largest face, because it says who meco is surest of
 * and does not move as people walk about — largest would let the framing wobble
 * across a burst of photographs.
 */
const leadingFace = (
  candidates: readonly Extract<Match, { by: "face" }>[]
): Extract<Match, { by: "face" }> | undefined =>
  candidates.reduce<Extract<Match, { by: "face" }> | undefined>(
    (best, candidate) => {
      if (best === undefined) return candidate;
      if (candidate.similarity !== best.similarity) {
        return candidate.similarity > best.similarity ? candidate : best;
      }

      return byRegionId(candidate.regionId, best.regionId) < 0
        ? candidate
        : best;
    },
    undefined
  );

/**
 * The number Match that leads: the lowest Region id.
 *
 * There is no evidence to rank them by. A number Match is a read digit found
 * on the Brand's own list, and every one of them is that equally — a `score`
 * off the reader would rank how clear the digits were, which is not how much
 * the photograph is about that kart. So the tie-break is the only rule, and it
 * is the same `regionId` order every other tie here uses.
 */
const leadingNumber = (
  candidates: readonly Extract<Match, { by: "number" }>[]
): Extract<Match, { by: "number" }> | undefined =>
  candidates.reduce<Extract<Match, { by: "number" }> | undefined>(
    (best, candidate) =>
      best === undefined || byRegionId(candidate.regionId, best.regionId) < 0
        ? candidate
        : best,
    undefined
  );

/**
 * The `match` rung: a Crop framed on one named individual in a crowd, which is
 * why Person matching exists at all. When a Region carries a Match for this
 * Brand, that Region leads however small it is.
 *
 * `persons` narrows who may lead and nothing else. A photograph that matched
 * somebody, but nobody on the list, composes nothing here and falls through to
 * the next `pinTo` entry rather than leading on the unlisted Match: a caller
 * who named `persons` asked for those people, and choosing the window around a
 * different named person would leak who else is in the picture. An empty list
 * is legal and means no Match may lead.
 *
 * **A face Match leads ahead of a number one.** Both name the same kind of
 * thing — this Person is here — but they compose different Subjects, and the
 * face is the tighter and the better measured of the two: the Eye Line
 * criterion was taken on face boxes and nothing here was taken on karts. The
 * number Match is what answers when the face rule has nothing to say at all,
 * which is the crash helmet this feature was built for
 * ([#227](https://github.com/timschoch/meco/issues/227)). So the order is not
 * a ranking of evidence; it is a ranking of compositions.
 *
 * The two Subjects:
 *
 * - a face Match composes the leading face's box alone, and keeps every face,
 *   on the same reasoning as the `face` rung;
 * - a number Match composes the **kart** — the `vehicle` identify named,
 *   unioned with the driver on it by the `kart` rung's own rule — and keeps
 *   what that union joined. The Match names the vehicle and never the digits,
 *   so there is no case here where the Subject is a number plate.
 *
 * `matches` arrives already scoped to the request's Brand, and the kept Regions
 * are put in tier order by the ladder, so neither rule is this rung's to keep.
 * Whether a Match names a Region this picture actually holds is this rung's
 * question, because a Match naming anything else has no box to frame — and
 * asking it is what leaves the leader's own Region certain to exist.
 */
export const matchSubject = (
  regions: Region[],
  matches: Match[],
  request: FramingRequest
): ComposedSubject | undefined => {
  const { persons } = request;
  const named = (match: Match): boolean =>
    persons === undefined || persons.includes(match.personId);

  const faces = regions.filter((region) => region.kind === "face");
  const faceIds = new Set(faces.map((face) => face.id));

  const faceLeader = leadingFace(
    matches.filter(
      (match): match is Extract<Match, { by: "face" }> =>
        match.by === "face" && faceIds.has(match.regionId) && named(match)
    )
  );
  if (faceLeader !== undefined) {
    return {
      resolvedBy: "match",
      leadRegionId: faceLeader.regionId,
      subject: faces.find((face) => face.id === faceLeader.regionId)!.box,
      keptRegionIds: faces.map((face) => face.id),
    };
  }

  const karts = new Map(
    regions
      .filter((region) => region.kind === "vehicle")
      .map((region) => [region.id, region])
  );
  const numberLeader = leadingNumber(
    matches.filter(
      (match): match is Extract<Match, { by: "number" }> =>
        match.by === "number" && karts.has(match.regionId) && named(match)
    )
  );
  if (numberLeader === undefined) return undefined;

  return kartAround(regions, karts.get(numberLeader.regionId)!, "match");
};
