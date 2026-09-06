/**
 * Enrolment: refused whole, or done whole.
 *
 * `enrol` is the one place identify writes. It runs in the spec's order and
 * nothing reaches the store or the database before every refusal has had its
 * chance, because a refused photograph that left an object under
 * `people/<brand>/<personId>/` is a biometric leak and not a failed call
 * (`docs/specs/identify.md`, "What `enrol` does"; ADR-0012, Decision 4).
 *
 * Every refusal is an {@link IdentifyError} whose message says what photograph
 * would have worked. The Brand cannot fix a number it was not told, and the
 * prototype's silence here is what let the back of a crash helmet be enrolled
 * as a Person (ADR-0003, amendment).
 */
import { createHash } from "node:crypto";
import type { Annotation, Region } from "@meco/contracts";
import { peoplePrefix } from "@meco/records";
import { IdentifyError } from "./errors";
import {
  type IdentifiableFace,
  decodedShorterSide,
  idNumber,
  identifiableFace,
} from "./face";
import type { EnrolRequest, Enrolment, IdentifyDeps } from "./types";

/** The Content Hash of the bytes, computed the one way the store computes it. */
const contentHash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Whether a consent date is a date at all.
 *
 * `EnrolRequest` types `consentAt` as a required `Date`, and the gateway is an
 * untyped door: what arrives can be absent, `null`, or an `Invalid Date` from
 * a string nobody could parse. All three are "no consent date", and the answer
 * to all three is the same refusal — never a template of a person who has not
 * agreed (ADR-0012, Decision 4).
 */
const isConsentDate = (consentAt: Date | undefined): consentAt is Date =>
  consentAt instanceof Date && !Number.isNaN(consentAt.getTime());

/** Every face Region of an Annotation, in Region id order. */
const facesOf = (annotation: Annotation): readonly Region[] =>
  annotation.regions
    .filter((region) => region.kind === "face")
    .sort((a, b) => idNumber(a.id) - idNumber(b.id));

/**
 * The refusal for a face that is not an Identifiable Face: the code a caller
 * switches on, and in front of the measurement the photograph that would have
 * worked instead. The four sentences are the prototype's, which said them and
 * was then not asked (issue #34).
 */
const notIdentifiableError = (
  face: Exclude<IdentifiableFace, { readonly identifiable: true }>,
  regionId: string
): IdentifyError => {
  switch (face.reason) {
    case "no-print":
      return new IdentifyError(
        "no_print",
        `${regionId} could not be aligned into a Face Print. Enrol from a photograph of this person square on to the camera, eyes open and unobstructed.`
      );
    case "other-model":
      return new IdentifyError(
        "other_model",
        `${regionId} was printed by another Model than the Print Model this Brand's People are compared under. Re-annotate the photograph and enrol it again.`
      );
    case "too-small":
      return new IdentifyError(
        "too_small",
        `${regionId} is too small to identify anybody by: ${face.detail}. Enrol from a photograph taken closer, or one where this person fills more of the frame.`
      );
    case "not-a-face":
      return new IdentifyError(
        "not_a_face",
        `${regionId} is not a face: ${face.detail}. Enrol from a photograph with the helmet off and the face visible.`
      );
  }
};

/**
 * The chosen face, or the outcome that asks the Brand which face it meant.
 *
 * `choose` is an outcome and not an error (decision on #87, Q11): a photograph
 * with several faces is a normal photograph, and the caller's next move is to
 * send the same bytes back with a `regionId`. The two other answers to "which
 * face" — none at all, and a `regionId` naming no face here — are refusals and
 * are thrown, so this function answers on both channels on purpose: the return
 * type carries what the caller can act on, and the throw carries what it got
 * wrong.
 */
type Choice =
  | { readonly chosen: Region }
  | { readonly choose: Extract<Enrolment, { status: "choose" }> };

const chooseFace = (
  annotation: Annotation,
  regionId: string | undefined
): Choice => {
  const faces = facesOf(annotation);
  const [only] = faces;
  if (only === undefined) {
    throw new IdentifyError(
      "no_face",
      "No face was detected in this photograph. Enrol from a photograph where this person's face is visible and square on to the camera."
    );
  }

  if (regionId !== undefined) {
    const named = faces.find((region) => region.id === regionId);
    if (named === undefined) {
      throw new IdentifyError(
        "unknown_region",
        `${regionId} is not a face in this photograph. The faces are ${faces.map((face) => face.id).join(", ")}.`
      );
    }
    return { chosen: named };
  }

  if (faces.length === 1) return { chosen: only };

  return {
    choose: {
      status: "choose",
      // Largest first, by the same measurement the size floor is judged on, so
      // the number a Brand sorts by and the number that refuses a face are one
      // number rather than two that disagree at the boundary.
      faces: faces
        .map((face) => ({
          regionId: face.id,
          box: face.box,
          pixels: decodedShorterSide(face, annotation),
        }))
        .sort((a, b) => b.pixels - a.pixels),
    },
  };
};

/**
 * The whole enrolment. Steps 1 to 4 read and refuse; step 5 writes, and is the
 * first line that touches the store or the database.
 */
export const enrolRule = async (
  deps: IdentifyDeps,
  request: EnrolRequest
): Promise<Enrolment> => {
  const { records, store, annotate } = deps;
  const { brand, personId, bytes, contentType, consentAt, regionId } = request;

  // 1. The two facts about the Person, before any work is done on the bytes.
  // A Person of another Brand is unknown here for the same reason they are
  // never a Match there: this Brand's rows are the only rows read.
  const person = await records.people.get(brand, personId);
  if (person === null) {
    throw new IdentifyError(
      "unknown_person",
      `No Person ${personId} in brand ${brand}. Create the Person before enrolling a photograph of them.`
    );
  }
  if (!isConsentDate(consentAt)) {
    throw new IdentifyError(
      "consent_required",
      `Enrolling ${personId} needs the date they consented to being recognised. No Face Print of a person who has not agreed is ever computed or stored.`
    );
  }

  // 2. The Annotation of these exact bytes. The hash is computed here and
  // handed over, so the models client can refuse an Annotation that is about
  // some other photograph rather than filing it under this one's hash.
  const hash = contentHash(bytes);
  const annotation = await annotate(bytes, { hash });

  // 3. Which face, or the question back.
  const choice = chooseFace(annotation, regionId);
  if (!("chosen" in choice)) return choice.choose;
  const chosen = choice.chosen;

  // 4. The same Identifiable Face gate `match` applies, so a face enrolled
  // here is a face that will be compared there.
  const face = identifiableFace(chosen, annotation);
  if (!face.identifiable) throw notIdentifiableError(face, chosen.id);

  // 5. Written, in the order records requires: the bytes, then the File that
  // names their hash, then the Annotation of that File, then the row.
  //
  // The bytes have to go first — records refuses a File whose bytes it has not
  // been given a key for — which is the one window where a photograph exists
  // in the store with nothing pointing at it. A row is what an Erasure walks,
  // so bytes that never got one would be unreachable by every later delete;
  // the catch below closes the window by removing them again.
  const put = await store.put(
    peoplePrefix(brand, personId),
    bytes,
    contentType
  );
  try {
    if (put.hash !== hash) {
      throw new Error(
        `@meco/identify: the store filed these bytes under ${put.hash} and the Annotation was made for ${hash}. Both are meant to be the SHA-256 of the same bytes.`
      );
    }
    await records.files.ensure({
      hash,
      mime: contentType,
      width: annotation.width,
      height: annotation.height,
      bytes: bytes.byteLength,
      storeKey: put.key,
    });
    await records.annotations.put(annotation);
    const photo = await records.people.enrol({
      brand,
      personId,
      hash,
      // The Reference Photo's own key, under `people/`. The `files` row may
      // name a `sources/` key for the same bytes; records owns that rule.
      storeKey: put.key,
      regionId: chosen.id,
      facePrint: face.print,
      consentAt: consentAt.toISOString(),
    });

    return { status: "enrolled", photo, annotation };
  } catch (error) {
    // Only bytes this call wrote. `deduped` says the object was already there,
    // and an existing object under a Person's prefix belongs to a row this
    // call did not make: deleting it would erase somebody else's enrolment.
    if (!put.deduped) {
      await store.delete(put.key).catch((cleanup: unknown) => {
        throw new Error(
          `@meco/identify: an enrolment failed and its bytes could not be removed from ${put.key}, which leaves a Face Print no Erasure can reach. The enrolment failed with: ${String(error)}`,
          { cause: cleanup }
        );
      });
    }
    throw error;
  }
};
