/**
 * Prove the crop solver frames a Subject where it says it does.
 *
 * The solver is the one part of a Crop that can be checked without an image: it
 * is arithmetic over Subject Boxes, so every claim it makes — the Subject sits
 * on a golden line, the window stays on the picture, a Subject that cannot be
 * held is reported rather than quietly lost — is a number this script can read
 * back. What it cannot check is whether sharp cut the right pixels; that is
 * `scripts/http-probe.ts`.
 */
import {
  PHI_LINES,
  solveCrop,
  type CropFallback,
  type CropWindow,
  type PixelSize,
  type SubjectArea,
  type SubjectBox,
} from "../src/crop-solver.js";

const problems: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok    " : "FAIL  "}${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) problems.push(name);
}

/** A Subject Box with the parts a test does not care about filled in. */
function box(partial: Partial<SubjectBox> = {}): SubjectBox {
  return {
    x: 0.28,
    y: 0.4,
    width: 0.08,
    height: 0.1,
    producer: "saliency",
    priority: 30,
    keep: true,
    ...partial,
  };
}

/** Where the Subject ended up inside the window, as fractions of the frame. */
function framed(window: CropWindow, subject: SubjectBox, source: PixelSize) {
  return {
    x:
      ((subject.x + subject.width / 2) * source.width - window.left) / window.width,
    y:
      ((subject.y + subject.height / 2) * source.height - window.top) /
      window.height,
  };
}

/** Within the 2 % the acceptance criterion allows. */
const onPhiLine = (fraction: number) =>
  PHI_LINES.some((line) => Math.abs(line - fraction) <= 0.02);

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const SOURCE: PixelSize = { width: 4000, height: 3000 };

const SHAPES = [
  { label: "1:1", width: 1080, height: 1080 },
  { label: "4:5", width: 1080, height: 1350 },
  { label: "9:16", width: 1080, height: 1920 },
  { label: "16:9", width: 1920, height: 1080 },
];

// --------------------------------------------------- golden-line placement

/**
 * One Subject, four shapes.
 *
 * Only an axis the window can actually slide along is asserted. A cover window
 * touches the Source Image on one axis by construction — a 9:16 window out of a
 * landscape photograph is already the full height — and an axis with no slack is
 * fixed by the shape, not by the solver.
 */
console.log("one Subject Box, each shape, zoom 1");
for (const shape of SHAPES) {
  const subject = box();
  const window = solveCrop([subject], SOURCE, shape);
  const at = framed(window, subject, SOURCE);
  const slack = {
    x: SOURCE.width - window.width > 1,
    y: SOURCE.height - window.height > 1,
  };
  const placed =
    (!slack.x || onPhiLine(at.x)) && (!slack.y || onPhiLine(at.y));
  check(
    `${shape.label} put the Subject on a golden line or reported a fallback`,
    placed || window.fallback !== undefined,
    `x=${pct(at.x)}${slack.x ? "" : " (fixed)"} y=${pct(at.y)}${slack.y ? "" : " (fixed)"}` +
      ` window=${String(window.width)}x${String(window.height)}@${String(window.left)},${String(window.top)}` +
      `${window.fallback ? ` fallback=${window.fallback}` : ""}`,
  );
  check(
    `${shape.label} kept the window on the Source Image`,
    window.left >= 0 &&
      window.top >= 0 &&
      window.left + window.width <= SOURCE.width &&
      window.top + window.height <= SOURCE.height,
  );
}

/** Zoomed in, both axes have slack, so both must land on a line. */
console.log("\none Subject Box, each shape, zoom 1.6 — both axes free");
for (const shape of SHAPES) {
  const subject = box();
  const window = solveCrop([subject], SOURCE, shape, { zoom: 1.6 });
  const at = framed(window, subject, SOURCE);
  check(
    `${shape.label} put both axes on a golden line`,
    (onPhiLine(at.x) && onPhiLine(at.y)) || window.fallback !== undefined,
    `x=${pct(at.x)} y=${pct(at.y)}${window.fallback ? ` fallback=${window.fallback}` : ""}`,
  );
}

// ------------------------------------------------------------- the producers

console.log("\nproducers");

const anchored = solveCrop(
  [box({ producer: "anchor", priority: 20, x: 0, y: 0, width: 0, height: 0, framedAt: { x: 0, y: 0 } })],
  SOURCE,
  { width: 1080, height: 1920 },
);
check("a Crop Anchor names itself", anchored.resolvedBy === "anchor", anchored.resolvedBy);
check(
  "the top-left anchor keeps the top-left corner",
  anchored.left === 0 && anchored.top === 0,
  `${String(anchored.left)},${String(anchored.top)}`,
);

const centred = solveCrop(
  [box({ producer: "centre", priority: 10, x: 0.5, y: 0.5, width: 0, height: 0, framedAt: { x: 0.5, y: 0.5 } })],
  SOURCE,
  { width: 1080, height: 1920 },
);
check("the centre producer names itself", centred.resolvedBy === "centre", centred.resolvedBy);
check(
  "the centre producer centres the window",
  Math.abs(centred.left + centred.width / 2 - SOURCE.width / 2) <= 1,
  `centre at ${String(centred.left + centred.width / 2)} of ${String(SOURCE.width)}`,
);

/**
 * The highest tier decides alone — the crowd only enters the containment test.
 * Solving with the crowd present must give the very window the leader alone
 * would have produced, which is what "it pins on our face" means as a number.
 */
const leader = box({ x: 0.62, y: 0.55, width: 0.06, height: 0.08, priority: 40 });
const crowd = box({ x: 0.05, y: 0.1, width: 0.2, height: 0.3, priority: 10, keep: false });
const pinned = solveCrop([crowd, leader], SOURCE, { width: 1080, height: 1080 });
const alone = solveCrop([leader], SOURCE, { width: 1080, height: 1080 });
check(
  "the top-priority Subject wins the anchor",
  pinned.left === alone.left && pinned.top === alone.top,
  `with the crowd ${String(pinned.left)},${String(pinned.top)} — alone ${String(alone.left)},${String(alone.top)}`,
);

/**
 * Eyes go on the upper golden line, not the middle of the head. A portrait
 * Source Image, because a landscape one leaves a tall crop no height to move in.
 */
const PORTRAIT: PixelSize = { width: 3000, height: 4000 };
const portrait = box({ x: 0.3, y: 0.2, width: 0.4, height: 0.45, eyeY: 0.32 });
const headroom = solveCrop([portrait], PORTRAIT, { width: 1080, height: 1080 });
const eyeAt = (portrait.eyeY! * PORTRAIT.height - headroom.top) / headroom.height;
check(
  "an eye line lands on the upper golden line",
  Math.abs(eyeAt - PHI_LINES[0]) <= 0.02 || headroom.fallback !== undefined,
  `eyes at ${pct(eyeAt)}${headroom.fallback ? ` fallback=${headroom.fallback}` : ""}`,
);

// ---------------------------------------------------------- fallback ladder

console.log("\nfallback ladder");

const expectFallback = (
  name: string,
  window: CropWindow,
  wanted: CropFallback,
) => {
  check(
    name,
    window.fallback === wanted && !window.satisfied,
    `fallback=${window.fallback ?? "none"} satisfied=${String(window.satisfied)}`,
  );
};

// Too tight a zoom for the Subject, but the full cover window holds it.
expectFallback(
  "a Subject that only fits zoomed out reports zoom-out",
  solveCrop([box({ x: 0.3, y: 0.3, width: 0.35, height: 0.4 })], SOURCE, SHAPES[0]!, {
    zoom: 2.5,
  }),
  "zoom-out",
);

// Fits the cover window, but not once the golden line pushes it against an edge.
expectFallback(
  "a Subject the golden line would push out reports relax",
  solveCrop([box({ x: 0.15, y: 0.3, width: 0.7, height: 0.2 })], SOURCE, SHAPES[0]!),
  "relax",
);

// Two Subjects too far apart to share a frame; the lesser one is sacrificed.
expectFallback(
  "two Subjects that cannot share a frame report drop",
  solveCrop(
    [
      box({ x: 0.02, y: 0.05, width: 0.1, height: 0.1, priority: 40 }),
      box({ x: 0.9, y: 0.85, width: 0.08, height: 0.1, priority: 10 }),
    ],
    SOURCE,
    SHAPES[2]!,
  ),
  "drop",
);

// One Subject wider than any window of this shape: nothing can hold it.
expectFallback(
  "a Subject wider than the frame reports clip",
  solveCrop([box({ x: 0.02, y: 0.3, width: 0.96, height: 0.2 })], SOURCE, SHAPES[2]!),
  "clip",
);

check(
  "a Crop that needed no rescue says so",
  (() => {
    const w = solveCrop([box()], SOURCE, SHAPES[0]!);
    return w.satisfied && w.fallback === undefined;
  })(),
);

// --------------------------------------------------------------- Subject Area

console.log("\nSubject Area");

const SQUARE = { width: 1080, height: 1080 };

/**
 * A Subject with a size, filling an area it can reach.
 *
 * The zoom is the claim under test: 800 pixels of Subject filling 40 % of the
 * frame fixes the window at 2000, which is neither the cover window nor
 * anything the golden grid would have picked.
 */
const AREA: SubjectArea = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };
const sized = box({ x: 0.2, y: 0.4, width: 0.2, height: 0.2 });
const filled = solveCrop([sized], SOURCE, SQUARE, { subjectArea: AREA });
check(
  "a Subject Area sizes the window from the Subject",
  filled.width === 2000 && filled.height === 2000,
  `${String(filled.width)}x${String(filled.height)}`,
);
check(
  "the Subject fills the Subject Area it was given",
  filled.subjectAreaSatisfied === true,
  `satisfied=${String(filled.subjectAreaSatisfied)}` +
    ` subject=${pct(sized.width * SOURCE.width / filled.width)} of the frame`,
);
check(
  "the Subject Area moved the window off the golden grid",
  (() => {
    const golden = solveCrop([sized], SOURCE, SQUARE);
    return golden.width !== filled.width || golden.left !== filled.left;
  })(),
);

/**
 * A bare point cannot fill anything, so the area only says where to aim. That is
 * every producer meco has today; a detected face is what makes the zoom bind.
 */
const aimed = solveCrop([box({ x: 0.5, y: 0.5, width: 0, height: 0 })], SOURCE, SQUARE, {
  subjectArea: AREA,
});
const aimedAt = framed(aimed, box({ x: 0.5, y: 0.5, width: 0, height: 0 }), SOURCE);
check(
  "a Subject Area aims a point at its centre",
  Math.abs(aimedAt.x - 0.5) <= 0.01 && Math.abs(aimedAt.y - 0.5) <= 0.01,
  `x=${pct(aimedAt.x)} y=${pct(aimedAt.y)}`,
);
check("a point that landed in the area says so", aimed.subjectAreaSatisfied === true);

/**
 * Relaxed: the Subject is pinned to the left edge of the Source Image, so no
 * window can put it as far right as the area asks. The Crop still happens and
 * still holds the Subject — the flag is what carries the bad news.
 */
const edge = box({ x: 0, y: 0.4, width: 0.05, height: 0.05 });
const RIGHT: SubjectArea = { x: 0.55, y: 0.3, width: 0.4, height: 0.4 };
const missed = solveCrop([edge], SOURCE, { width: 1080, height: 1920 }, { subjectArea: RIGHT });
check(
  "a Subject Area the Source Image cannot reach is reported, not faked",
  missed.subjectAreaSatisfied === false,
  `satisfied=${String(missed.subjectAreaSatisfied)} window at ${String(missed.left)},${String(missed.top)}`,
);
check(
  "a missed Subject Area still keeps the Subject in shot",
  missed.satisfied && missed.left === 0,
  `satisfied=${String(missed.satisfied)} left=${String(missed.left)}`,
);
/**
 * Two Subjects, one area. The window is sized around the union of them, so it
 * has to be positioned around that union too — pinning it on the leader instead
 * would slide a window that exactly fits both of them off both of them.
 */
const pair = solveCrop(
  [
    box({ x: 0.3, y: 0.4, width: 0.08, height: 0.1, priority: 30 }),
    box({ x: 0.42, y: 0.4, width: 0.08, height: 0.1, priority: 10 }),
  ],
  SOURCE,
  SQUARE,
  { subjectArea: AREA },
);
check(
  "two Subjects together fill the Subject Area",
  pair.subjectAreaSatisfied === true,
  `satisfied=${String(pair.subjectAreaSatisfied)} window=${String(pair.width)}@${String(pair.left)},${String(pair.top)}`,
);

/**
 * A Subject Area overrides a Crop Anchor, which is the coarser statement. A wide
 * shape out of this Source Image is full width, so the vertical axis is the only
 * one with room to show the override at all.
 */
const centreAnchor = box({
  producer: "anchor",
  priority: 20,
  x: 0.5,
  y: 0.5,
  width: 0,
  height: 0,
  framedAt: { x: 0.5, y: 0.5 },
});
const WIDE = { width: 1920, height: 1080 };
const anchorAlone = solveCrop([centreAnchor], SOURCE, WIDE);
const overridden = solveCrop([centreAnchor], SOURCE, WIDE, {
  subjectArea: { x: 0.3, y: 0.05, width: 0.4, height: 0.3 },
});
check(
  "a Subject Area outranks the Crop Anchor's own framing",
  overridden.top !== anchorAlone.top,
  `with the area ${String(overridden.top)}, with the anchor alone ${String(anchorAlone.top)}`,
);

/** Without one, nothing is claimed either way. */
check(
  "a Crop with no Subject Area reports nothing about one",
  solveCrop([sized], SOURCE, SQUARE).subjectAreaSatisfied === undefined,
);

// ------------------------------------------------------------------ refusals

console.log("\nrefusals");

const throws = (name: string, run: () => unknown) => {
  let threw = false;
  try {
    run();
  } catch {
    threw = true;
  }
  check(name, threw);
};

throws("no Subject Box at all is refused", () => solveCrop([], SOURCE, SHAPES[0]!));
throws("a Source Image with no size is refused", () =>
  solveCrop([box()], { width: 0, height: 0 }, SHAPES[0]!),
);
throws("a Crop size of zero is refused", () =>
  solveCrop([box()], SOURCE, { width: 0, height: 100 }),
);
throws("a Subject Area outside the frame is refused", () =>
  solveCrop([box()], SOURCE, SHAPES[0]!, {
    subjectArea: { x: 0.7, y: 0.1, width: 0.5, height: 0.2 },
  }),
);
throws("a Subject Area with no width is refused", () =>
  solveCrop([box()], SOURCE, SHAPES[0]!, {
    subjectArea: { x: 0.1, y: 0.1, width: 0, height: 0.2 },
  }),
);

/**
 * Too small: 3600 pixels of Subject filling a fifth of the frame needs an 18000
 * pixel window out of a 4000 pixel photograph. The message has to name both, or
 * a caller cannot tell whether to send a bigger picture or ask for less.
 */
let tooSmall = "";
try {
  solveCrop([box({ x: 0.05, y: 0.05, width: 0.9, height: 0.9 })], SOURCE, SQUARE, {
    subjectArea: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
  });
} catch (err) {
  tooSmall = (err as Error).message;
}
check("a Source Image too small for the Subject Area is refused", tooSmall !== "");
check(
  "the refusal names the required and the available size",
  tooSmall.includes("18000x18000") && tooSmall.includes("3000x3000"),
  tooSmall,
);

console.log(
  `\n${problems.length === 0 ? "solver OK" : `${String(problems.length)} FAILED`}`,
);
if (problems.length > 0) process.exitCode = 1;
