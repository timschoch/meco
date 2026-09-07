/**
 * The shapes that cross identify's seam. Declared apart from the factory so
 * that the Match Rule can answer in them without importing the factory back.
 */
import type { Annotation, Box, Match } from "@meco/contracts";
import type { Records, ReferencePhoto } from "@meco/records";
import type { Store } from "@meco/store";

/**
 * How a photograph reaches the Annotator: its bytes, or a Signed URL the far
 * side fetches for itself.
 *
 * Structurally the models client's own `AnnotateSource`, written out here
 * because identify may not import `@meco/models` — the two containers share no
 * server code (`packages/README.md`). The URL form exists because a body over
 * 4.5 MB cannot cross the service binding (#201), and a Reference Photo is
 * routinely over it.
 */
export type AnnotateSource = Uint8Array | { readonly url: string };

/**
 * What turns a photograph into an Annotation: the models client in production,
 * a fixture-backed fake in the suite. The one place identify substitutes a
 * model for data, and it is never called by `match`.
 */
export type Annotator = (
  source: AnnotateSource,
  options: { readonly hash: string }
) => Promise<Annotation>;

export interface IdentifyDeps {
  readonly records: Records;
  readonly store: Store;
  readonly annotate: Annotator;
}

export interface MatchRequest {
  readonly annotation: Annotation;
  readonly brand: string;
}

/**
 * What identify says about one face Region. Five answers where the prototype
 * had one silence: named, compared and nobody, never compared, not a face
 * worth comparing, and not a face at all.
 */
export type FaceVerdict = { readonly regionId: string } & (
  | {
      /**
       * The helmet itself, at or over `NOT_A_FACE_CERTAIN` to a Not-a-Face
       * Print: nothing to name and nothing to hide. The one verdict redact
       * never sees a Region for (#248).
       */
      readonly verdict: "not-a-face";
      /** What was measured, so a Brand can act on it. */
      readonly detail: string;
    }
  | {
      readonly verdict: "match";
      readonly personId: string;
      readonly similarity: number;
      /** The best other Person, when the Brand enrolled more than one. */
      readonly runnerUp?: number;
    }
  | {
      readonly verdict: "unknown";
      /** Absent when there was no Person to compare against at all. */
      readonly best?: number;
      readonly runnerUp?: number;
    }
  | {
      readonly verdict: "uncompared";
      readonly reason: "no-print" | "other-model";
    }
  | {
      readonly verdict: "not-identifiable";
      readonly reason: "too-small" | "not-a-face";
      /** What was measured, so a Brand can act on it. */
      readonly detail: string;
    }
);

/** Everything identify answers for one Annotation and one Brand. */
export interface Identification {
  /** The `match` verdicts as contracts Matches, sorted by Region id number. */
  readonly matches: readonly Match[];
  /** One per face Region, sorted by Region id number. */
  readonly faces: readonly FaceVerdict[];
  /** The ids of the Reference Photos left out of the comparison. */
  readonly unusableReferencePhotos: readonly string[];
}

export interface EnrolRequest {
  readonly brand: string;
  readonly personId: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** Required. Absent is refused: no template of an unconsenting person. */
  readonly consentAt: Date;
  /** Which face, when the photograph has several. */
  readonly regionId?: string;
}

export type Enrolment =
  | {
      readonly status: "enrolled";
      readonly photo: ReferencePhoto;
      readonly annotation: Annotation;
    }
  | {
      readonly status: "choose";
      readonly faces: readonly {
        readonly regionId: string;
        readonly box: Box;
        readonly pixels: number;
      }[];
    };

export interface Identify {
  match(input: MatchRequest): Promise<Identification>;
  enrol(input: EnrolRequest): Promise<Enrolment>;
}
