/**
 * Framing a Crop, as arithmetic.
 *
 * Every producer of framing information — a Crop Anchor today, sharp's saliency
 * point, a matched face later — hands this module the same thing: Subject Boxes
 * in fractions of the Source Image. One solver turns them into one crop window,
 * so a new detector adds a producer rather than a second way of framing.
 *
 * The solve is closed-form rather than a search over candidate windows. See
 * `docs/adr/0001-analytic-solver-over-search-based-crop.md` for why. The
 * practical consequence is this file: it imports no image library and touches no
 * pixels, so the framing can be reasoned about and tested without an image.
 */

/** 1/φ, and the two lines it puts across a frame. */
const PHI_INV = 0.6180339887498949;
export const PHI_LINES = [1 - PHI_INV, PHI_INV] as const;

/**
 * Sub-pixel slack for the containment test.
 *
 * The window is rounded to whole pixels before it is cut, so insisting on exact
 * containment would report a fallback for a Subject that is half a pixel out.
 */
const SLACK_PX = 0.5;

/** Who decided the framing. Ordered as the producers are consulted. */
export const CROP_PRODUCERS = ["saliency", "anchor", "centre"] as const;

export type CropProducer = (typeof CROP_PRODUCERS)[number];

/** A position in a frame or a Source Image, as fractions from the top-left. */
export interface FractionPoint {
  x: number;
  y: number;
}

/** Where a Subject sits in a Source Image. Fractions, 0..1 from the top-left. */
export interface SubjectBox {
  x: number;
  y: number;
  /** Zero for a producer that yields a point rather than a region. */
  width: number;
  height: number;
  /** Which producer yielded this box, and the name the result reports. */
  producer: CropProducer;
  /** Higher wins the anchor. A found Subject outranks a Crop Anchor. */
  priority: number;
  /** Must survive the Crop. A Subject that may be sacrificed sets this false. */
  keep: boolean;
  /**
   * Where in the output frame this Subject asks to sit, fractions of the frame.
   * A Crop Anchor knows its own answer — "top-left" means the top-left corner —
   * so it names one. A found Subject leaves it open and takes the golden line
   * nearest to where the photographer already had it.
   */
  framePosition?: FractionPoint;
  /** Eye midpoint, fraction of the Source Image height. Drives headroom. */
  eyeY?: number;
}

export interface PixelSize {
  width: number;
  height: number;
}

export interface SolveOptions {
  /**
   * How tightly to crop around the anchor. 1 is the largest window of the
   * required shape that fits inside the Source Image; above 1 tightens it.
   */
  zoom?: number;
}

/** Which rung of the ladder rescued a window that could not hold every Subject. */
export type CropFallback = "zoom-out" | "relax" | "drop" | "clip";

/** A crop window in Source Image pixels, and how it came about. */
export interface CropWindow {
  left: number;
  top: number;
  width: number;
  height: number;
  resolvedBy: CropProducer;
  /** Every Subject marked `keep` survived at the composition first asked for. */
  satisfied: boolean;
  /** Set only when `satisfied` is false. */
  fallback?: CropFallback;
}

/** A rectangle in Source Image pixels. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high);

/**
 * The golden line closest to where the Subject already sits.
 *
 * Nearest rather than fixed, because it moves the frame as little as possible:
 * it keeps the photographer's composition and makes clamping less likely. A
 * Subject sitting exactly in the middle is equidistant from both lines; the
 * upper-left one wins, which at least makes the choice deterministic.
 */
function nearestPhiLine(fraction: number): number {
  return PHI_LINES.reduce((best, line) =>
    Math.abs(line - fraction) < Math.abs(best - fraction) ? line : best,
  );
}

function toPixels(box: SubjectBox, source: PixelSize): Rect {
  return {
    left: box.x * source.width,
    top: box.y * source.height,
    width: box.width * source.width,
    height: box.height * source.height,
  };
}

function union(rects: Rect[]): Rect {
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.left + r.width));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  return { left, top, width: right - left, height: bottom - top };
}

function contains(window: Rect, inner: Rect): boolean {
  return (
    inner.left >= window.left - SLACK_PX &&
    inner.top >= window.top - SLACK_PX &&
    inner.left + inner.width <= window.left + window.width + SLACK_PX &&
    inner.top + inner.height <= window.top + window.height + SLACK_PX
  );
}

/**
 * The Subject the frame is composed around, and the box that speaks for it.
 *
 * The highest priority tier decides alone: in a group photo that is what pins
 * the frame on the face we recognise rather than on the middle of the crowd.
 * Within a tie the anchor is Thumbor's priority×area weighted centroid, so two
 * equally important Subjects pull the frame between them.
 */
function anchorOf(
  boxes: SubjectBox[],
  source: PixelSize,
): { point: FractionPoint; leader: SubjectBox; tied: boolean } {
  const top = Math.max(...boxes.map((b) => b.priority));
  const leaders = boxes.filter((b) => b.priority === top);
  const leader = leaders[0] as SubjectBox;

  if (leaders.length === 1) {
    const rect = toPixels(leader, source);
    return {
      point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      leader,
      tied: false,
    };
  }

  const weights = leaders.map((b) => b.priority * b.width * b.height);
  const total = weights.reduce((sum, w) => sum + w, 0);
  const centres = leaders.map((b) => toPixels(b, source));
  // Every leader may be a point, which weighs nothing. Then they count equally.
  const weightOf = (index: number) => (total > 0 ? (weights[index] as number) : 1);
  const divisor = total > 0 ? total : leaders.length;

  return {
    point: {
      x:
        centres.reduce(
          (sum, r, i) => sum + weightOf(i) * (r.left + r.width / 2),
          0,
        ) / divisor,
      y:
        centres.reduce(
          (sum, r, i) => sum + weightOf(i) * (r.top + r.height / 2),
          0,
        ) / divisor,
    },
    leader,
    tied: true,
  };
}

/** The largest window of the required shape that fits, tightened by the zoom. */
function windowSize(source: PixelSize, aspect: number, zoom: number): PixelSize {
  const width =
    source.width / source.height > aspect ? source.height * aspect : source.width;
  return { width: width / zoom, height: width / aspect / zoom };
}

/** Put `point` at `at` inside a window of `size`, then keep the window on the image. */
function place(
  point: FractionPoint,
  at: FractionPoint,
  size: PixelSize,
  source: PixelSize,
): Rect {
  return {
    left: clamp(point.x - at.x * size.width, 0, source.width - size.width),
    top: clamp(point.y - at.y * size.height, 0, source.height - size.height),
    width: size.width,
    height: size.height,
  };
}

/**
 * Where the Subject would sit if the window were simply centred on it.
 *
 * This is the "where it already was" the golden line is chosen nearest to. It
 * has to be measured after clamping: a Subject near an edge cannot be centred,
 * and pretending otherwise would pick a line the window can never reach.
 */
function naturalPosition(
  point: FractionPoint,
  size: PixelSize,
  source: PixelSize,
): FractionPoint {
  const centred = place(point, { x: 0.5, y: 0.5 }, size, source);
  return {
    x: (point.x - centred.left) / size.width,
    y: (point.y - centred.top) / size.height,
  };
}

/** Whole pixels, still of the required shape and still inside the image. */
function round(rect: Rect, source: PixelSize): Rect {
  const width = clamp(Math.round(rect.width), 1, source.width);
  const height = clamp(Math.round(rect.height), 1, source.height);
  return {
    left: clamp(Math.round(rect.left), 0, source.width - width),
    top: clamp(Math.round(rect.top), 0, source.height - height),
    width,
    height,
  };
}

/**
 * The crop window for a set of Subject Boxes at a required shape.
 *
 * Pure: the same inputs always give the same window, and no pixel is read to
 * produce it.
 */
export function solveCrop(
  boxes: SubjectBox[],
  source: PixelSize,
  target: PixelSize,
  options: SolveOptions = {},
): CropWindow {
  if (boxes.length === 0) {
    throw new Error("solveCrop needs at least one Subject Box.");
  }
  if (source.width <= 0 || source.height <= 0) {
    throw new Error(
      `Source Image size must be positive, got ${String(source.width)}x${String(source.height)}.`,
    );
  }
  if (target.width <= 0 || target.height <= 0) {
    throw new Error(
      `Crop size must be positive, got ${String(target.width)}x${String(target.height)}.`,
    );
  }

  const aspect = target.width / target.height;
  const asked = Math.max(1, options.zoom ?? 1);
  const { point, leader, tied } = anchorOf(boxes, source);

  /**
   * The headroom rule. An eye line is the one place a portrait must not be
   * framed on its centre: put the eyes on the upper golden line and the head
   * sits where a photographer would have put it. A tie has no single face to
   * read the eyes off, so the rule only applies to a lone leader.
   */
  const eyeY = !tied && leader.eyeY !== undefined ? leader.eyeY : undefined;
  const anchor: FractionPoint =
    eyeY === undefined ? point : { x: point.x, y: eyeY * source.height };

  const kept = boxes.filter((b) => b.keep);

  const solve = (zoom: number, relax: number, subjects: SubjectBox[]) => {
    const size = windowSize(source, aspect, zoom);
    const natural = naturalPosition(anchor, size, source);
    const wanted: FractionPoint = leader.framePosition ?? {
      x: nearestPhiLine(natural.x),
      y: eyeY === undefined ? nearestPhiLine(natural.y) : PHI_LINES[0],
    };
    // Relaxing slides the target towards the middle of the frame: the Subject
    // stays in shot and the composition degrades instead of the Crop failing.
    const at: FractionPoint = {
      x: wanted.x + (0.5 - wanted.x) * relax,
      y: wanted.y + (0.5 - wanted.y) * relax,
    };
    const window = place(anchor, at, size, source);
    const held = subjects.length === 0 || contains(window, union(subjects.map((b) => toPixels(b, source))));
    return { window, held };
  };

  const done = (rect: Rect, fallback?: CropFallback): CropWindow => ({
    ...round(rect, source),
    resolvedBy: leader.producer,
    satisfied: fallback === undefined,
    ...(fallback ? { fallback } : {}),
  });

  const first = solve(asked, 0, kept);
  if (first.held) return done(first.window);

  // The ladder, cheapest repair first. Every rung is reported, because a Crop
  // that silently gave up on a Subject is worse than one that says it did.
  if (asked > 1) {
    const wider = solve(1, 0, kept);
    if (wider.held) return done(wider.window, "zoom-out");
  }

  for (const relax of [0.5, 1]) {
    const relaxed = solve(asked, relax, kept);
    if (relaxed.held) return done(relaxed.window, "relax");
  }

  const droppable = [...kept].sort((a, b) => a.priority - b.priority);
  for (let dropped = 1; dropped < droppable.length; dropped++) {
    const remaining = droppable.slice(dropped);
    const smaller = solve(asked, 1, remaining);
    if (smaller.held) return done(smaller.window, "drop");
  }

  // Nothing fits. Centre on what matters and accept the clipping, having said so.
  const size = windowSize(source, aspect, 1);
  const all = union((kept.length > 0 ? kept : boxes).map((b) => toPixels(b, source)));
  const centre = { x: all.left + all.width / 2, y: all.top + all.height / 2 };
  return done(place(centre, { x: 0.5, y: 0.5 }, size, source), "clip");
}
