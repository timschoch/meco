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

/**
 * What a rung of `pinTo` answers with when it composes something. The rung
 * that answers decides all four fields at once, so no caller can pair a
 * `resolvedBy` with another rung's Subject.
 *
 * Declared here rather than beside a rung, so that every rung can be its own
 * file without any of them importing another.
 */
export interface ComposedSubject {
  resolvedBy: ResolvedBy;
  leadRegionId: string;
  /** The composed Subject, in source fractions. */
  subject: Box;
  /**
   * Every Region this rung keeps in frame, the leader included, in tier order.
   * `lib/tiers.ts` applies it to whichever rung answered.
   */
  keptRegionIds: string[];
}

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
  /**
   * Every Region the answering rung kept in frame, **in tier order**: the
   * Leading Subject, then a matched non-leading Region, then every other kept
   * Region, each group by Region id.
   *
   * The same order on every rung, so the drop rung (#108) has one promise to
   * read rather than one per rung: the cheapest Subject to sacrifice is the
   * last one. A Match keeps its middle tier whichever rung answered, since the
   * `face` rung can answer a request whose Matches `persons` all excluded.
   */
  keptRegionIds: string[];
  droppedRegionIds: string[];
  satisfied: boolean;
  fallback?: FallbackRung;
  /**
   * Whether the Subject filled the Subject Area, measured on the window
   * actually cut. Only when the request named an area.
   */
  subjectAreaSatisfied?: boolean;
  /**
   * A ratio of sizes: 1 when the Source Image was big enough to fill the area,
   * the factor it fell short by otherwise. An area missed for any other reason
   * — a window the picture's edge pushed off it — is an unsatisfied area at a
   * shortfall of 1.
   */
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
