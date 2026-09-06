/**
 * The Match Rule: the arithmetic that turns an Annotation and a Brand's People
 * into one Face Verdict per face Region.
 *
 * Open set. "Nobody" is a valid answer and the common one, so a face that
 * clears neither the threshold nor the margin is unknown rather than assigned
 * to whoever was nearest (`CONTEXT.md`, Match).
 *
 * Whether a face can be compared at all is not asked here: that is the
 * Identifiable Face gate in `face.ts`, which `enrol` asks the same way.
 */
import type { Annotation, Match, Region } from "@meco/contracts";
import type { PersonWithPrints, ReferencePhoto } from "@meco/records";
import { MATCH_MARGIN, MATCH_THRESHOLD } from "./constants";
import {
  disqualifyingNotAFace,
  idNumber,
  identifiableFace,
  isComparablePrint,
  similarity,
} from "./face";
import type { FaceVerdict, Identification } from "./types";

/** A Person as the rule compares them: their id and their usable prints. */
interface Comparable {
  readonly personId: string;
  readonly prints: readonly (readonly number[])[];
}

/**
 * The Brand's People with the prints the rule may compare, and the Reference
 * Photos it left out. A print is unusable in two ways: it came from another
 * Print Model, so it would be measured against a threshold nobody calibrated
 * for it; or it is a Not-a-Face Print's neighbour, so it would lend its
 * Person's name to whatever else resembles a crash helmet.
 */
const partitionPrints = (
  people: readonly PersonWithPrints[]
): { comparable: Comparable[]; unusable: string[] } => {
  const unusable: string[] = [];
  const usable = (photo: ReferencePhoto): boolean => {
    if (!isComparablePrint(photo.facePrint)) {
      unusable.push(photo.id);
      return false;
    }
    if (disqualifyingNotAFace(photo.facePrint.vector) !== null) {
      unusable.push(photo.id);
      return false;
    }
    return true;
  };
  const comparable = people.map((person) => ({
    personId: person.id,
    prints: person.photos.filter(usable).map((photo) => photo.facePrint.vector),
  }));
  return { comparable, unusable };
};

/**
 * One face against every Person. Best similarity per Person, the runner-up the
 * best other Person — never the second-best print of the same one, which would
 * make a Person with two photographs their own rival.
 */
const compare = (
  print: readonly number[],
  people: readonly Comparable[]
): { personId: string; best: number; runnerUp?: number } | null => {
  const scored = people
    .filter((person) => person.prints.length > 0)
    .map((person) => ({
      personId: person.personId,
      // The best photograph, not the mean of them: the threshold was
      // calibrated on the best, and centroid aggregation measured worse
      // (ADR-0012, Decision 3). Enrolling another photograph must never lower
      // a Person's own similarity.
      best: person.prints.reduce(
        (high, one) => Math.max(high, similarity(print, one)),
        Number.NEGATIVE_INFINITY
      ),
    }))
    .sort((a, b) => b.best - a.best);

  const [leader, second] = scored;
  if (leader === undefined) return null;
  return second === undefined
    ? { personId: leader.personId, best: leader.best }
    : { personId: leader.personId, best: leader.best, runnerUp: second.best };
};

const verdictFor = (
  region: Region,
  image: Annotation,
  people: readonly Comparable[]
): FaceVerdict => {
  const regionId = region.id;

  const face = identifiableFace(region, image);
  if (!face.identifiable) {
    if (face.reason === "no-print" || face.reason === "other-model") {
      return { regionId, verdict: "uncompared", reason: face.reason };
    }
    return {
      regionId,
      verdict: "not-identifiable",
      reason: face.reason,
      detail: face.detail,
    };
  }

  const scored = compare(face.print.vector, people);
  // Nobody enrolled, or nobody with a usable print. There was no comparison,
  // so there is no best: a zero here would read as a measured dissimilarity.
  if (scored === null) return { regionId, verdict: "unknown" };

  const { personId, best, runnerUp } = scored;
  const clearsThreshold = best >= MATCH_THRESHOLD;
  const clearsMargin =
    runnerUp === undefined || best - runnerUp >= MATCH_MARGIN;
  if (clearsThreshold && clearsMargin) {
    return {
      regionId,
      verdict: "match",
      personId,
      similarity: best,
      ...(runnerUp === undefined ? {} : { runnerUp }),
    };
  }
  return {
    regionId,
    verdict: "unknown",
    best,
    ...(runnerUp === undefined ? {} : { runnerUp }),
  };
};

/**
 * The whole Identification for one Annotation and one Brand. Pure: everything
 * it needs has already been read.
 */
export const matchRule = (
  annotation: Annotation,
  brand: string,
  people: readonly PersonWithPrints[]
): Identification => {
  const { comparable, unusable } = partitionPrints(people);

  const faces = annotation.regions
    .filter((region) => region.kind === "face")
    .sort((a, b) => idNumber(a.id) - idNumber(b.id))
    .map((region) => verdictFor(region, annotation, comparable));

  const matches: Match[] = faces.flatMap((face) =>
    face.verdict === "match"
      ? [
          {
            regionId: face.regionId,
            personId: face.personId,
            brand,
            similarity: face.similarity,
          },
        ]
      : []
  );

  return { matches, faces, unusableReferencePhotos: unusable };
};
