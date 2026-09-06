/**
 * The shapes that cross identify's seam. Declared apart from the factory so
 * that the Match Rule can answer in them without importing the factory back.
 */
import type { Annotation, Box, Match } from "@meco/contracts";
import type { Records, ReferencePhoto } from "@meco/records";
import type { Store } from "@meco/store";

/**
 * What turns bytes into an Annotation: the models client in production, a
 * fixture-backed fake in the suite. The one place identify substitutes a model
 * for data, and it is never called by `match`.
 */
export type Annotator = (
  bytes: Uint8Array,
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
 * What identify says about one face Region. Four answers where the prototype
 * had one silence: named, compared and nobody, never compared, and not a face
 * worth comparing.
 */
export type FaceVerdict = { readonly regionId: string } & (
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
