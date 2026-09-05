import type { Annotation, Box, FramingRequest, Match } from "@meco/contracts";

/**
 * What frame is given: an analysis of the bytes, the names `identify` could
 * put to the faces in them, and what this one output needs. The source size
 * comes from the Annotation, so frame takes no size argument and the two can
 * never disagree.
 */
export interface FrameInput {
  annotation: Annotation;
  matches?: Match[];
  request: FramingRequest;
}

/**
 * The rectangle to cut, in whole Source Image pixels. Deliberately not a
 * contracts `Box`: a `Box` is fractions, and a type that looked like one and
 * was not would be the `w`/`h` mistake of ADR-0002 in a new costume.
 */
export interface CropWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which rung composed the Subject the window was placed on. */
export type ResolvedBy = "match" | "face" | "kart" | "anchor" | "center";

/** The step of the ladder that rescued a window which could not hold everything. */
export type FallbackRung = "zoom-out" | "relax" | "drop" | "clip";

/**
 * A decision with its reasons attached, never a bare rectangle. Stored
 * verbatim by `records`, so every field here is something the webui can show
 * and a test can read back with no image.
 */
export interface Framing {
  /** Whole Source Image pixels. */
  window: CropWindow;
  /** The same window in source fractions. What `compose` cuts and scales by. */
  windowFraction: Box;
  resolvedBy: ResolvedBy;
  /** Absent when the anchor or the centre answered: neither is a Region. */
  leadRegionId?: string;
  /**
   * The composed Subject, in source fractions. Absent when the anchor or the
   * centre answered: nothing was composed, and a window standing in for a
   * Subject would be held by every rung of the ladder without meaning it.
   */
  subject?: Box;
  keptRegionIds: string[];
  droppedRegionIds: string[];
  satisfied: boolean;
  fallback?: FallbackRung;
  /** Only when the request named a Subject Area. */
  subjectAreaSatisfied?: boolean;
  /** 1 when satisfied, the factor short otherwise. */
  subjectAreaShortfall?: number;
  /** Only when `occlusion` was non-empty. */
  occlusionClear?: boolean;
}

const PHI = (1 + Math.sqrt(5)) / 2;

/**
 * The two Golden Lines, `1 - 1/φ` then `1/φ`. Derived and not typed out,
 * because a decimal literal is a place a digit can go missing.
 */
export const PHI_LINES: readonly [number, number] = [1 - 1 / PHI, 1 / PHI];

/**
 * The most Occlusion Zones frame will answer for. The wall is the contracts
 * schema's, enforced by the gateway at the edge; frame's `RangeError` above the
 * bound is the defensive invariant underneath it, because the Free Area sweep
 * is polynomial in the zone count and an unbounded list has no best-effort
 * answer to give.
 *
 * Re-exported and no longer declared here: contracts owns the number (#137), so
 * the wall and the invariant cannot drift apart. Ledgered on #101.
 */
export { MAX_OCCLUSION_ZONES } from "@meco/contracts";
