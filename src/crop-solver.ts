/**
 * Framing a Crop, as arithmetic.
 *
 * Every producer of framing information — a Crop Anchor, sharp's saliency point,
 * a detected face, a matched Person later — hands this module the same thing:
 * Subject Boxes in fractions of the Source Image. One solver turns them into one
 * crop window, so a new detector adds a producer rather than a second way of
 * framing.
 *
 * Where the Subject then lands is the other half. A Subject Area names that
 * rectangle outright; the golden grid is what this module aims at when nobody
 * named one. Both are positioned the same way and both fall back the same way.
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
export const CROP_PRODUCERS = [
  "person",
  "face",
  "kart",
  "saliency",
  "anchor",
  "centre",
] as const;

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
  framedAt?: FractionPoint;
  /** Eye midpoint, fraction of the Source Image height. Drives headroom. */
  eyeY?: number;
}

export interface PixelSize {
  width: number;
  height: number;
}

/**
 * The part of an Image Slot a Template requires the Subject to fill, as
 * fractions of the output, 0..1 from the top-left. See CONTEXT.md.
 *
 * It lives here rather than next to the image library because it is the target
 * the solver aims at: the golden grid is what the solver does when nobody names
 * one, not a different way of framing.
 */
export interface SubjectArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SolveOptions {
  /**
   * How tightly to crop around the anchor. 1 is the largest window of the
   * required shape that fits inside the Source Image; above 1 tightens it.
   *
   * Ignored when a Subject Area is given and the Subject has a size, because
   * then the zoom is not a preference — it is whatever makes the Subject fill
   * the area.
   */
  zoom?: number;
  /**
   * The rectangle of the output frame the Subject must fill. A Template
   * declares one; a caller may name one for a single Crop. Given one, the
   * solver derives the zoom from it and aims at its centre instead of at a
   * golden line, and says in `subjectAreaSatisfied` whether it got there.
   */
  subjectArea?: SubjectArea;
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
  /**
   * The Subject landed inside the Subject Area. Set only when one was asked
   * for — a Crop that named no area has no claim to report either way.
   */
  subjectAreaSatisfied?: boolean;
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

/** A Subject Area has to be a real rectangle, and it has to be in the frame. */
function insideFrame(area: SubjectArea): boolean {
  return (
    area.width > 0 &&
    area.height > 0 &&
    area.x >= 0 &&
    area.y >= 0 &&
    area.x + area.width <= 1 &&
    area.y + area.height <= 1
  );
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

/** The Subject Area, projected off the output frame back onto a crop window. */
function areaRect(window: Rect, area: SubjectArea): Rect {
  return {
    left: window.left + area.x * window.width,
    top: window.top + area.y * window.height,
    width: area.width * window.width,
    height: area.height * window.height,
  };
}

/**
 * The zoom that makes the Subject fill the Subject Area.
 *
 * A Subject Area is a statement about proportions: a Subject `sw` wide filling a
 * fraction `area.width` of the frame fixes the frame at `sw / area.width`. Both
 * axes propose a window and the larger one wins, since the other then has room
 * to spare. Expressing the answer as a zoom rather than as a window size is what
 * lets the rest of the solver — where the window is put, and the fallback ladder
 * that rescues it — stay one code path with or without an area.
 *
 * `null` when no window can be derived: a Subject Box from the saliency, anchor
 * or centre producer is a bare point, and a point has no size to scale up. Then
 * the area only says where to aim, and the zoom the caller asked for still
 * stands. The face producer is the one that yields a real rectangle, so it is
 * the one that makes this bind — including the refusal below.
 */
function areaZoom(
  area: SubjectArea,
  subject: Rect,
  source: PixelSize,
  aspect: number,
  target: PixelSize,
): number | null {
  const needed = Math.max(subject.width / area.width, (subject.height / area.height) * aspect);
  if (!(needed > 0)) return null;

  // Refusing rather than fudging: a Subject that small in the Source Image
  // cannot fill the area at this shape, and a Crop that quietly framed
  // something else would be worse than a Crop that said so.
  const cover = windowSize(source, aspect, 1);
  if (needed > cover.width + SLACK_PX) {
    const px = (n: number) => String(Math.round(n));
    throw new Error(
      `The Source Image is too small to fill the Subject Area at ${String(target.width)}x${String(target.height)}: ` +
        `it needs a ${px(needed)}x${px(needed / aspect)} window, and the largest that fits this ` +
        `${String(source.width)}x${String(source.height)} Source Image is ${px(cover.width)}x${px(cover.height)}.`,
    );
  }
  // Never below 1: the half-pixel of slack the refusal above allows would
  // otherwise ask for a window fractionally larger than the Source Image.
  return Math.max(1, cover.width / needed);
}

/**
 * The zoom that gives an eye line room to reach the upper golden line.
 *
 * A cover window touches the Source Image on one axis by construction, and for a
 * portrait photograph cut to a taller shape that axis is the vertical one: the
 * window is already the full height of the picture, so nothing can slide it and
 * the eyes stay wherever the photographer left them. Tightening the window is the
 * only thing that buys the vertical slack back — and tightening is what a person
 * cutting a portrait into a story would do anyway.
 *
 * The two bounds are the two edges of the window: `PHI_LINES[0]` of its height has
 * to fit above the eyes and the remainder below. The smaller of the two wins. The
 * answer is a zoom rather than a size so that the rest of the solve, and the
 * ladder that rescues it, stay one code path.
 *
 * Never below 1, because this is a convention about where a head looks best and
 * not a licence to widen a Crop the caller asked to be tight. Never so tight that
 * the face would not fit either: headroom that cropped the face off would be the
 * exact opposite of the point.
 *
 * `face` is the leading Subject Box alone — the one the eyes were read off — and
 * not every Subject in the picture. See the call site.
 */
function headroomZoom(
  eyes: number,
  face: Rect,
  source: PixelSize,
  aspect: number,
): number {
  const cover = windowSize(source, aspect, 1);
  const room = Math.min(eyes / PHI_LINES[0], (source.height - eyes) / PHI_LINES[1]);
  // The window still has to hold the face, and the required shape ties the two
  // axes together, so the height it needs is the larger of what each axis asks
  // for.
  const floor = Math.max(face.height, face.width / aspect);
  const height = Math.max(floor, Math.min(cover.height, room));
  return height > 0 ? Math.max(1, cover.height / height) : 1;
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
  const area = options.subjectArea;
  if (area && !insideFrame(area)) {
    throw new Error(
      `A Subject Area must be a positive rectangle inside the frame, got ` +
        `${String(area.width)}x${String(area.height)} at ${String(area.x)},${String(area.y)}.`,
    );
  }

  const aspect = target.width / target.height;
  const { point, leader, tied } = anchorOf(boxes, source);

  // What the composition is measured against: the Subjects that must survive,
  // or every Subject when none of them was marked as having to.
  const kept = boxes.filter((b) => b.keep);
  const subject = union((kept.length > 0 ? kept : boxes).map((b) => toPixels(b, source)));

  /**
   * The headroom rule. An eye line is the one place a portrait must not be
   * framed on its centre: put the eyes on the upper golden line and the head
   * sits where a photographer would have put it. A tie has no single face to
   * read the eyes off, so the rule only applies to a lone leader.
   *
   * A Subject Area turns it off. The rule is a convention for where a head looks
   * best when nobody said; a Subject Area is somebody saying, about the whole
   * Subject Box rather than about the eyes.
   */
  const eyeY = area === undefined && !tied && leader.eyeY !== undefined ? leader.eyeY : undefined;

  // An eye line also sizes the window, because at the shapes a portrait is most
  // often cut to there is no vertical slack left to place it in otherwise. The
  // caller's own zoom still wins when it asks for more.
  //
  // The floor is the leader's own box and not the union of every Subject: the
  // rule is about the face the eyes belong to, and whether the others fit is the
  // ladder's question, asked after. Flooring it on the union instead made the
  // rule switch itself off in precisely the case a Person Match creates — a
  // group, where the faces stand wider apart than any window that gives one of
  // them headroom, so the eye line could never reach the golden line however far
  // the ladder went on to sacrifice. Recorded as an amendment to
  // `docs/adr/0001-analytic-solver-over-search-based-crop.md`.
  const startZoom =
    (area ? areaZoom(area, subject, source, aspect, target) : null) ??
    Math.max(
      1,
      options.zoom ?? 1,
      eyeY === undefined
        ? 1
        : headroomZoom(eyeY * source.height, toPixels(leader, source), source, aspect),
    );

  /**
   * The point the window is built around.
   *
   * Normally the leader's, because in a crowd the frame belongs to the Subject
   * that matters. A Subject Area moves it to the centre of the whole union: the
   * area was just used to size the window around that union, so anything else
   * would put a window that exactly fits the Subjects off the Subjects.
   */
  const anchor: FractionPoint = area
    ? { x: subject.left + subject.width / 2, y: subject.top + subject.height / 2 }
    : eyeY === undefined
      ? point
      : { x: point.x, y: eyeY * source.height };

  const solve = (zoom: number, relax: number, subjects: SubjectBox[]) => {
    const size = windowSize(source, aspect, zoom);
    const natural = naturalPosition(anchor, size, source);
    // A Subject Area outranks a Crop Anchor: both are the caller speaking, but
    // one names an exact rectangle and the other one of nine regions.
    const wanted: FractionPoint = area
      ? { x: area.x + area.width / 2, y: area.y + area.height / 2 }
      : (leader.framedAt ?? {
          x: nearestPhiLine(natural.x),
          y: eyeY === undefined ? nearestPhiLine(natural.y) : PHI_LINES[0],
        });
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

  const done = (rect: Rect, fallback?: CropFallback): CropWindow => {
    const window = round(rect, source);
    return {
      ...window,
      resolvedBy: leader.producer,
      satisfied: fallback === undefined,
      ...(fallback ? { fallback } : {}),
      // Measured on the window actually cut, not on the one first asked for: a
      // rung of the ladder can rescue the Subject and miss the area doing it,
      // and that is exactly the case this flag exists to report. Measured
      // against every Subject the Crop promised to keep, including one the
      // `drop` rung then sacrificed — a sacrifice is a miss.
      ...(area ? { subjectAreaSatisfied: contains(areaRect(window, area), subject) } : {}),
    };
  };

  const first = solve(startZoom, 0, kept);
  if (first.held) return done(first.window);

  // The ladder, cheapest repair first. Every rung is reported, because a Crop
  // that silently gave up on a Subject is worse than one that says it did.
  if (startZoom > 1) {
    const wider = solve(1, 0, kept);
    if (wider.held) return done(wider.window, "zoom-out");
  }

  for (const relax of [0.5, 1]) {
    const relaxed = solve(startZoom, relax, kept);
    if (relaxed.held) return done(relaxed.window, "relax");
  }

  const droppable = [...kept].sort((a, b) => a.priority - b.priority);
  for (let dropped = 1; dropped < droppable.length; dropped++) {
    const remaining = droppable.slice(dropped);
    const smaller = solve(startZoom, 1, remaining);
    if (smaller.held) return done(smaller.window, "drop");
  }

  // Nothing fits. Centre on what matters and accept the clipping, having said so.
  const size = windowSize(source, aspect, 1);
  const centre = {
    x: subject.left + subject.width / 2,
    y: subject.top + subject.height / 2,
  };
  return done(place(centre, { x: 0.5, y: 0.5 }, size, source), "clip");
}
