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
  [box({ producer: "anchor", priority: 20, x: 0, y: 0, width: 0, height: 0, framePosition: { x: 0, y: 0 } })],
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
  [box({ producer: "centre", priority: 10, x: 0.5, y: 0.5, width: 0, height: 0, framePosition: { x: 0.5, y: 0.5 } })],
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

console.log(
  `\n${problems.length === 0 ? "solver OK" : `${String(problems.length)} FAILED`}`,
);
if (problems.length > 0) process.exitCode = 1;
