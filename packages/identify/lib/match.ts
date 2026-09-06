/**
 * The Match Rule: the arithmetic that turns an Annotation and a Brand's People
 * into one Face Verdict per face Region.
 *
 * Open set. "Nobody" is a valid answer and the common one, so a face that
 * clears neither the threshold nor the margin is unknown rather than assigned
 * to whoever was nearest (`CONTEXT.md`, Match).
 */
import type { Annotation, FacePrint, Match, Region } from "@meco/contracts";
// The one number identify takes from another module rather than holding: the
// bound the models host decodes to before any adapter sees a photograph. A
// second copy of it is what the entry-point boundary exists to prevent, and it
// is what {@link MIN_FACE_PX} is judged after.
import { DECODE_BOUND } from "@meco/models";
import type { PersonWithPrints, ReferencePhoto } from "@meco/records";
import {
  MATCH_MARGIN,
  MATCH_THRESHOLD,
  MIN_FACE_PX,
  NOT_A_FACE_THRESHOLD,
  PRINT_DIMENSIONS,
  PRINT_MODEL,
} from "./constants";
import { NOT_A_FACE_PRINTS, type NotAFacePrint } from "./not-a-face-prints";
import type { FaceVerdict, Identification } from "./types";

/**
 * Whether a Face Print can be compared at all: it names the Print Model, and
 * it has that Model's number of dimensions.
 *
 * The length is checked as well as the name, because contracts fixes a print's
 * norm and not its length: a four-float vector labelled `edgeface/1` would
 * otherwise be scored against a 512-float one term by term, and four terms of
 * two unrelated networks can clear the threshold. A print of the wrong length
 * did not come from this Model, whatever it says.
 */
const isComparablePrint = (print: FacePrint): boolean =>
  print.model.name === PRINT_MODEL.name &&
  print.model.version === PRINT_MODEL.version &&
  print.vector.length === PRINT_DIMENSIONS;

/**
 * The cosine of two Face Prints. Both are on the unit sphere — the contracts
 * schema refuses one that is not — so the dot product is the cosine, and the
 * clamp is against floating-point drift past 1 rather than against a shape the
 * schema already refused.
 */
const similarity = (a: readonly number[], b: readonly number[]): number => {
  let sum = 0;
  // Both are PRINT_DIMENSIONS long: nothing that failed `isComparablePrint`
  // reaches here, which is what makes the index-by-index product a cosine.
  for (const [index, value] of a.entries()) sum += value * (b[index] ?? 0);
  return Math.min(1, Math.max(-1, sum));
};

/**
 * The shorter side of a face, in the Decoded Image. The floor is judged there
 * and not in the photograph, because that is the size the Enricher saw: a face
 * 80 px across in a 8000 px photograph is 16 px by the time a model reads it.
 */
const decodedShorterSide = (region: Region, image: Annotation): number => {
  const scale = Math.min(1, DECODE_BOUND / Math.max(image.width, image.height));
  return (
    Math.min(region.box.width * image.width, region.box.height * image.height) *
    scale
  );
};

/**
 * The Not-a-Face Print that takes a Face Print's identity away, and nothing
 * when none does. It is the nearest of them when several disqualify, so the
 * refusal names the strongest reason.
 *
 * Asked of the detection and of every enrolled print, because both directions
 * are dangerous and only one of them is catchable on the detection: a real
 * face can score over the Match Threshold against a helmet
 * (`paddock-mixed#4`, 0.5091), and no check on that face can refuse it,
 * because it is a face. Dropping the Reference Photo is what protects the
 * Brand, and is what protects a Brand that enrolled before the rule existed
 * (ADR-0003, amendment).
 */
const disqualifyingNotAFace = (
  vector: readonly number[]
): { print: NotAFacePrint; similarity: number } | null => {
  let nearest: { print: NotAFacePrint; similarity: number } | null = null;
  for (const print of NOT_A_FACE_PRINTS) {
    const scored = similarity(vector, print.vector);
    if (scored < NOT_A_FACE_THRESHOLD) continue;
    if (nearest === null || scored > nearest.similarity) {
      nearest = { print, similarity: scored };
    }
  }
  return nearest;
};

/**
 * `face-10` after `face-2`: the number decides, never the string.
 *
 * `@meco/contracts` owns the `<kind>-<n>` format and its schema refuses any
 * other, so the parse cannot fail. It exports no comparator, and asking it for
 * one is a contracts change this ticket has no reason to make.
 */
const idNumber = (regionId: string): number =>
  Number.parseInt(regionId.slice(regionId.indexOf("-") + 1), 10);

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

  // Never compared, in two kinds: the Enricher could not align the face, or it
  // did and a Model the rule was not calibrated on made the print. Neither is
  // an answer about who the face is.
  if (region.facePrint === undefined) {
    return { regionId, verdict: "uncompared", reason: "no-print" };
  }
  if (!isComparablePrint(region.facePrint)) {
    return { regionId, verdict: "uncompared", reason: "other-model" };
  }

  const shorterSide = decodedShorterSide(region, image);
  if (shorterSide < MIN_FACE_PX) {
    return {
      regionId,
      verdict: "not-identifiable",
      reason: "too-small",
      detail: `${Math.round(shorterSide)} px in the decoded image, under the ${MIN_FACE_PX} px floor`,
    };
  }

  // Large enough to have been printed, and printed by the right Model — and
  // still not a face. The back of a crash helmet is what taught this rule
  // (issue #34): it was enrolled as a Person, and a stranger in a helmet was
  // named after them with their face left sharp.
  const notAFace = disqualifyingNotAFace(region.facePrint.vector);
  if (notAFace !== null) {
    return {
      regionId,
      verdict: "not-identifiable",
      reason: "not-a-face",
      detail: `${notAFace.similarity.toFixed(4)} to the Not-a-Face Print ${notAFace.print.id} (${notAFace.print.saw}), at or over the ${NOT_A_FACE_THRESHOLD} threshold`,
    };
  }

  const scored = compare(region.facePrint.vector, people);
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
