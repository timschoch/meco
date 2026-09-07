/**
 * What identify knows about one face Region before it knows who it is: whether
 * the print can be compared at all, how big the face was when the Enricher saw
 * it, and whether it is a face.
 *
 * The two methods ask the same questions of the same Region and answer in two
 * vocabularies — `match` reports a Face Verdict and carries on, `enrol` refuses
 * the photograph — so the questions live here and each method maps the answer.
 * A second copy of the arithmetic is how the two would drift apart, and a face
 * `enrol` accepted that `match` will never compare is the drift that costs a
 * Brand a Person.
 */
import type { Annotation, FacePrint, Region } from "@meco/contracts";
// The one number identify takes from another module rather than holding: the
// bound the models host decodes to before any adapter sees a photograph. A
// second copy of it is what the entry-point boundary exists to prevent, and it
// is what {@link MIN_FACE_PX} is judged after.
import { DECODE_BOUND } from "@meco/models";
import {
  MIN_FACE_PX,
  NOT_A_FACE_CERTAIN,
  NOT_A_FACE_THRESHOLD,
  PRINT_DIMENSIONS,
  PRINT_MODEL,
} from "./constants";
import { NOT_A_FACE_PRINTS, type NotAFacePrint } from "./not-a-face-prints";

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
export const isComparablePrint = (print: FacePrint): boolean =>
  print.model.name === PRINT_MODEL.name &&
  print.model.version === PRINT_MODEL.version &&
  print.vector.length === PRINT_DIMENSIONS;

/**
 * The cosine of two Face Prints. Both are on the unit sphere — the contracts
 * schema refuses one that is not — so the dot product is the cosine, and the
 * clamp is against floating-point drift past 1 rather than against a shape the
 * schema already refused.
 */
export const similarity = (
  a: readonly number[],
  b: readonly number[]
): number => {
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
export const decodedShorterSide = (
  region: Region,
  image: Annotation
): number => {
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
export const disqualifyingNotAFace = (
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
export const idNumber = (regionId: string): number =>
  Number.parseInt(regionId.slice(regionId.indexOf("-") + 1), 10);

/**
 * Whether one face Region is an Identifiable Face, and what was measured when
 * it is not. The four refusals are the four the spec names, in the order they
 * are asked.
 *
 * `detail` is the measurement alone, deliberately without advice: `match`
 * reports it to a Brand reading the Gallery, and `enrol` puts the advice in
 * front of it ("closer", "helmet off") because there the answer is a refusal
 * somebody has to act on.
 */
export type IdentifiableFace =
  | { readonly identifiable: true; readonly print: FacePrint }
  | { readonly identifiable: false; readonly reason: "no-print" }
  | { readonly identifiable: false; readonly reason: "other-model" }
  | {
      readonly identifiable: false;
      readonly reason: "too-small";
      readonly detail: string;
    }
  | {
      readonly identifiable: false;
      readonly reason: "not-a-face";
      readonly detail: string;
      /**
       * At or over {@link NOT_A_FACE_CERTAIN}: the Region is the helmet
       * itself, not a face that resembles one, and there is nothing behind
       * it to hide. `match` answers `not-a-face` for it; `enrol` refuses it
       * exactly as it refuses the uncertain kind.
       */
      readonly certain: boolean;
    };

/**
 * The Identifiable Face gate, in the spec's order: printed at all, printed by
 * the Print Model, big enough in the Decoded Image, and a face. The print
 * comes back with the pass, so that no caller has to re-narrow the Region to
 * reach a print this function has already proved is there.
 */
export const identifiableFace = (
  region: Region,
  image: Annotation
): IdentifiableFace => {
  // Never compared, in two kinds: the Enricher could not align the face, or it
  // did and a Model the rule was not calibrated on made the print. Neither is
  // an answer about who the face is.
  const print = region.facePrint;
  if (print === undefined) return { identifiable: false, reason: "no-print" };
  if (!isComparablePrint(print)) {
    return { identifiable: false, reason: "other-model" };
  }

  const shorterSide = decodedShorterSide(region, image);
  if (shorterSide < MIN_FACE_PX) {
    return {
      identifiable: false,
      reason: "too-small",
      detail: `${Math.round(shorterSide)} px in the decoded image, under the ${MIN_FACE_PX} px floor`,
    };
  }

  // Large enough to have been printed, and printed by the right Model — and
  // still not a face. The back of a crash helmet is what taught this rule
  // (issue #34): it was enrolled as a Person, and a stranger in a helmet was
  // named after them with their face left sharp.
  //
  // Asked after the size floor on purpose: a 23 px face prints over even the
  // certainty (`street-karting-crowd`, 0.9320), and under the floor nothing a
  // print says is trusted. Swap the two and that face loses its blur (#248).
  const notAFace = disqualifyingNotAFace(print.vector);
  if (notAFace !== null) {
    const certain = notAFace.similarity >= NOT_A_FACE_CERTAIN;
    return {
      identifiable: false,
      reason: "not-a-face",
      certain,
      detail: `${notAFace.similarity.toFixed(4)} to the Not-a-Face Print ${notAFace.print.id} (${notAFace.print.saw}), at or over the ${certain ? NOT_A_FACE_CERTAIN : NOT_A_FACE_THRESHOLD} ${certain ? "certainty" : "threshold"}`,
    };
  }

  return { identifiable: true, print };
};
