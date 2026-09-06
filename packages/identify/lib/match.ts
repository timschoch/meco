/**
 * The Match Rule: the arithmetic that turns an Annotation and a Brand's People
 * into one Face Verdict per face Region.
 *
 * Open set. "Nobody" is a valid answer and the common one, so a face that
 * clears neither the threshold nor the margin is unknown rather than assigned
 * to whoever was nearest (`CONTEXT.md`, Match).
 */
import type { Annotation, FacePrint, Match, Region } from "@meco/contracts";
import type { PersonWithPrints, ReferencePhoto } from "@meco/records";
import {
  DECODE_BOUND,
  MATCH_MARGIN,
  MATCH_THRESHOLD,
  MIN_FACE_PX,
  PRINT_DIMENSIONS,
  PRINT_MODEL,
} from "./constants";
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
 * Photos it left out. A print that is not a comparable one is unusable: it
 * would be measured against a threshold nobody calibrated for it.
 */
const partitionPrints = (
  people: readonly PersonWithPrints[]
): { comparable: Comparable[]; unusable: string[] } => {
  const unusable: string[] = [];
  const comparable = people.map((person) => ({
    personId: person.id,
    prints: person.photos
      .filter((photo: ReferencePhoto) => {
        if (isComparablePrint(photo.facePrint)) return true;
        unusable.push(photo.id);
        return false;
      })
      .map((photo) => photo.facePrint.vector),
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
