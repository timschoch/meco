/**
 * Calibrate — and then keep guarding — the numbers that decide who meco names.
 *
 * `MATCH_THRESHOLD` and `MATCH_MARGIN` are two constants in `src/people.ts`, and
 * a constant with no evidence behind it is a guess with a decimal point. This
 * script is the evidence: it sweeps the threshold across its whole range over
 * the committed fixture faces, prints the table, and then asserts the operating
 * point the code actually ships.
 *
 * The failure it exists to prevent is a **false Match** — meco putting a name on
 * a stranger. Downstream that is not a wrong answer in a log, it is the wrong
 * person's face left sharp in a published post. So a missed Match is reported
 * and a false Match fails the run.
 *
 * ## What it runs on, and what that is worth
 *
 * The fixture set in `fixtures/faces/`, not on photographs of anyone meco has
 * enrolled — nobody is enrolled, and a threshold calibrated on an empty gallery
 * would be a number with no provenance at all. See
 * `docs/adr/0003-face-recognition-licence-consent-and-threshold.md`, which says
 * so in as many words and says when it has to be earned again.
 *
 * The Face Prints come from `fixtures/faces/face-prints.json`, written by
 * meco-faces' own ONNX path and kept current by `pnpm test:embed`. Reading them
 * rather than computing them is what lets the calibration run in meco, in
 * milliseconds, without ONNX Runtime — see ADR-0002 on why that dependency is
 * not here.
 *
 * ## How a Person is simulated
 *
 * A Person is one letter in `expected.json` and their Reference Photos are the
 * faces carrying it. Enrolling a Person means putting their faces in the gallery
 * as `EnrolledPrint`s; asking about a face means calling the real
 * `matchFacePrint` from `src/people.ts`. Nothing about the decision is
 * re-implemented here — a rule this script agreed with but the service did not
 * would be worse than no script.
 *
 * A face is never asked about against a gallery holding that same face. Person A
 * appears in three photographs, so "recognise A from the other two" is a real
 * question; a face compared with itself scores 1 and answers nothing.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { LONG_EDGE, boundedSource, type DetectedFace, type Detection } from "../src/faces.js";
import { NOT_A_FACE_PRINTS } from "../src/not-a-face-prints.js";
import {
  MATCH_MARGIN,
  MATCH_THRESHOLD,
  MIN_FACE_PX,
  NOT_A_FACE_THRESHOLD,
  cosineSimilarity,
  matchFacePrint,
  notAFace,
  whyNotIdentifiable,
  type EnrolledPrint,
} from "../src/people.js";

interface FixturePrint {
  name: string;
  file: string;
  label: string;
  person: string;
  print: number[];
}

const FIXTURES = fileURLToPath(new URL("../fixtures/faces/", import.meta.url));

const { prints: faces } = JSON.parse(
  await readFile(`${FIXTURES}face-prints.json`, "utf8"),
) as { prints: FixturePrint[] };

const people = [...new Set(faces.map((f) => f.person))].sort();

const problems: string[] = [];
function check(ok: boolean, name: string, detail = ""): void {
  console.log(`${ok ? "ok    " : "FAIL  "} ${name.padEnd(60)} ${detail}`);
  if (!ok) problems.push(name);
}

// ------------------------------------------- the size these numbers are for

/**
 * Every kart fixture is the bytes production would send, at the size it sends.
 *
 * `src/faces.ts` bounds a Source Image to `LONG_EDGE` before the models ever see
 * it, and `withoutEnlargement` means that bound only ever shrinks. So a fixture
 * committed *below* the bound is not a smaller copy of the production input — it
 * is a different input, one no caller can produce, and every number this script
 * derives from it describes a regime that does not exist.
 *
 * Issue #42 is what that costs. At 1400 px four of `paddock-mixed`'s faces fall
 * under `MIN_FACE_PX` and never reach the print comparison at all; at the 1600 px
 * bound all eight clear it and two cross-person pairs land over
 * `MATCH_THRESHOLD`. The suite passed either way, and at the smaller size it
 * credited `MIN_FACE_PX` for a separation the Not-a-Face rule was actually
 * making. A green suite that names the wrong load-bearing guard is how somebody
 * loosens the wrong constant.
 *
 * Two things are asserted, and both are needed:
 *
 * - **`boundedSource` returns the fixture unchanged.** Production sends these
 *   exact bytes. This is the invariant that keeps tracking `src/faces.ts` if the
 *   bound or the encoding ever changes, rather than restating today's value.
 * - **The fixture is as large as that photograph ever gets.** Pass-through alone
 *   is satisfied by *any* small image, so on its own it would have called the
 *   1400 px fixtures correct. `sources` in `expected.json` records the size of
 *   the Commons original, and `min(LONG_EDGE, natural)` is the only size a
 *   caller sending that photograph can produce.
 */
{
  const KARTS = fileURLToPath(new URL("../fixtures/karts/", import.meta.url));
  const { sources } = JSON.parse(await readFile(`${KARTS}expected.json`, "utf8")) as {
    sources: Record<string, { width: number; height: number }>;
  };

  for (const [file, natural] of Object.entries(sources)) {
    const bytes = await readFile(`${KARTS}${file}`);
    // `boundedSource` reports the size *after* EXIF orientation, which is the
    // frame every fraction downstream is in. Reading `sharp` metadata here
    // instead would compare a rotated fixture against the wrong edge.
    const bounded = await boundedSource(bytes);
    const longEdge = Math.max(bounded.sourceWidth, bounded.sourceHeight);
    const wanted = Math.min(LONG_EDGE, Math.max(natural.width, natural.height));

    check(
      bounded.bytes.equals(bytes),
      `${file} is what production sends, byte for byte`,
      `${String(bytes.length)} B in, ${String(bounded.bytes.length)} B out`,
    );
    check(
      longEdge === wanted,
      `${file} is committed at the production bound`,
      `${String(longEdge)} px, and the bound on a ${String(natural.width)}x${String(natural.height)} original is ${String(wanted)} px`,
    );
  }
}

/** One face enrolled for one Person, in the shape the store hands matching. */
/** A fixture's `file#index`, without the human's label after the dash. */
const shortName = (e: { name: string }): string => e.name.split(" — ")[0]!;

function enrol(face: FixturePrint): EnrolledPrint {
  return {
    personId: `person-${face.person}`,
    personName: `Person ${face.person}`,
    photoId: face.name,
    print: face.print,
    printedAt: "2026-09-05T00:00:00.000Z",
  };
}

// ------------------------------------------------------------ the raw numbers

/**
 * Every pair of fixture faces, which is what a threshold is a cut through.
 *
 * Printed in full rather than summarised. A calibration that shows only its two
 * extremes is asking to be believed; one that shows the distribution can be
 * argued with.
 */
const pairs: { a: FixturePrint; b: FixturePrint; same: boolean; cosine: number }[] = [];
for (let i = 0; i < faces.length; i++) {
  for (let j = i + 1; j < faces.length; j++) {
    const a = faces[i]!;
    const b = faces[j]!;
    pairs.push({ a, b, same: a.person === b.person, cosine: cosineSimilarity(a.print, b.print) });
  }
}

console.log(
  `${String(faces.length)} fixture faces, ${String(people.length)} people, ` +
    `${String(pairs.length)} pairs\n`,
);
for (const pair of [...pairs].sort((x, y) => y.cosine - x.cosine)) {
  console.log(
    `  ${pair.same ? "same  " : "differ"} ${pair.cosine.toFixed(4)}  ` +
      `${pair.a.name.replace(".png", "")} / ${pair.b.name.replace(".png", "")}`,
  );
}

const same = pairs.filter((p) => p.same);
const differ = pairs.filter((p) => !p.same);
const worstSame = Math.min(...same.map((p) => p.cosine));
const bestDiffer = Math.max(...differ.map((p) => p.cosine));

console.log(
  `\nsame person   ${String(same.length)} pairs, worst ${worstSame.toFixed(4)}` +
    `\ndifferent     ${String(differ.length)} pairs, best  ${bestDiffer.toFixed(4)}` +
    `\ngap           ${(worstSame - bestDiffer).toFixed(4)}\n`,
);

// ----------------------------------------------------------------- the sweep

/**
 * What one threshold would decide, over every face against every Brand.
 *
 * "Every Brand" is the sweep's other axis and not a detail: the gallery a face
 * is compared against changes the runner-up, and the runner-up is half the rule.
 * So each face is asked twice — once against a gallery of every Person but
 * itself's own photograph, and once against a gallery holding a single Person —
 * because a Brand with one Person enrolled has no runner-up at all and is the
 * case where the threshold has to hold up alone.
 */
interface Trial {
  face: FixturePrint;
  /** Which Persons the Brand has enrolled. */
  gallery: EnrolledPrint[];
  /** The Person this face really is, if the gallery knows them. */
  truth: string | null;
  label: string;
}

const trials: Trial[] = [];
for (const face of faces) {
  // The whole cast, minus this very photograph — a face must be recognised from
  // a different picture of the person or not at all.
  const others = faces.filter((f) => f.name !== face.name);
  trials.push({
    face,
    gallery: others.map(enrol),
    truth: others.some((f) => f.person === face.person) ? `person-${face.person}` : null,
    label: "everyone",
  });

  // And one Brand per Person, which is where a Brand that enrolled exactly one
  // human meets a photograph of somebody else.
  for (const person of people) {
    const only = others.filter((f) => f.person === person);
    if (only.length === 0) continue;
    trials.push({
      face,
      gallery: only.map(enrol),
      truth: person === face.person ? `person-${person}` : null,
      label: `only Person ${person}`,
    });
  }
}

interface Outcome {
  threshold: number;
  /** A stranger given a name, or a face given the wrong name. The bad one. */
  false: number;
  /** A face meco could have named and did not. Cautious, not wrong. */
  missed: number;
  correct: number;
}

function sweep(threshold: number, margin: number): Outcome {
  const out: Outcome = { threshold, false: 0, missed: 0, correct: 0 };
  for (const trial of trials) {
    // The shipped rule with the sweep's numbers in place of the shipped ones,
    // so the sweep and the service cannot drift apart.
    const match = decide(trial, threshold, margin);
    if (match === null) {
      if (trial.truth !== null) out.missed++;
    } else if (match.personId !== trial.truth) {
      out.false++;
    } else {
      out.correct++;
    }
  }
  return out;
}

/**
 * `matchFacePrint` with the sweep's threshold and margin.
 *
 * The shipped function reads its two constants from the module, which is right
 * for a service and useless for a sweep. Rather than make them parameters — and
 * so make it possible to call the real thing with the wrong numbers — the sweep
 * reproduces only the two comparisons, and the check at the bottom of this file
 * proves the reproduction agrees with the original at the shipped operating
 * point on every trial.
 */
function decide(
  trial: Trial,
  threshold: number,
  margin: number,
): { personId: string; score: number } | null {
  const best = new Map<string, number>();
  for (const record of trial.gallery) {
    const score = cosineSimilarity(trial.face.print, record.print);
    if (score > (best.get(record.personId) ?? -Infinity)) best.set(record.personId, score);
  }
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  const winner = ranked[0];
  if (!winner) return null;
  const runnerUp = ranked[1]?.[1] ?? null;
  if (winner[1] < threshold) return null;
  if (runnerUp !== null && winner[1] - runnerUp < margin) return null;
  return { personId: winner[0], score: winner[1] };
}

console.log(`${String(trials.length)} trials — every face against every gallery\n`);
console.log("threshold   false   missed   correct");
const table: Outcome[] = [];
for (let t = 0.2; t <= 0.85001; t += 0.05) {
  const rounded = +t.toFixed(2);
  const outcome = sweep(rounded, MATCH_MARGIN);
  table.push(outcome);
  console.log(
    `  ${rounded.toFixed(2)}    ${String(outcome.false).padStart(5)}   ` +
      `${String(outcome.missed).padStart(6)}   ${String(outcome.correct).padStart(7)}` +
      `${rounded === MATCH_THRESHOLD ? "   <- shipped" : ""}`,
  );
}
console.log();

/**
 * And the margin, at the shipped threshold.
 *
 * The table is flat, and that is the finding rather than a disappointment: no
 * two people in the fixture set look alike, so nothing here is ever decided by
 * the runner-up. A margin cannot be calibrated on a set that does not contain
 * the case it guards against, and printing the flat table is how this script
 * says so instead of implying a measurement it did not make.
 */
console.log("margin at the shipped threshold   false   missed   correct");
for (const m of [0, 0.02, 0.05, 0.1, 0.2, 0.4]) {
  const outcome = sweep(MATCH_THRESHOLD, m);
  console.log(
    `  ${m.toFixed(2)}                            ${String(outcome.false).padStart(5)}   ` +
      `${String(outcome.missed).padStart(6)}   ${String(outcome.correct).padStart(7)}` +
      `${m === MATCH_MARGIN ? "   <- shipped" : ""}`,
  );
}
console.log();

// ------------------------------------------------------- what the code ships

const clean = table.filter((o) => o.false === 0 && o.missed === 0);
const lowest = clean[0]?.threshold;
const highest = clean.at(-1)?.threshold;

check(
  clean.length > 0,
  "some threshold decides every trial correctly",
  clean.length > 0
    ? `${lowest!.toFixed(2)} to ${highest!.toFixed(2)} at margin ${String(MATCH_MARGIN)}`
    : "none does — the fixture set does not separate",
);

/**
 * The shipped operating point, decided by the shipped function.
 *
 * Not by `decide`. The table above is a survey and may be computed by the
 * sweep's own arithmetic; the two checks below are the gate, and a gate that ran
 * a copy of the code would pass while the code was broken. The agreement check
 * further down is what ties the survey back to the gate.
 */
function shippedOutcome(): Outcome {
  const out: Outcome = { threshold: MATCH_THRESHOLD, false: 0, missed: 0, correct: 0 };
  for (const trial of trials) {
    const match = matchFacePrint(trial.face.print, trial.gallery);
    if (match === null) {
      if (trial.truth !== null) out.missed++;
    } else if (match.personId !== trial.truth) {
      out.false++;
    } else {
      out.correct++;
    }
  }
  return out;
}

const shipped = shippedOutcome();

// The one that matters. A false Match is a stranger's name on a face, or one
// Person's name on another's, and it is why this script is in the gate.
check(
  shipped.false === 0,
  `no stranger is matched at threshold ${String(MATCH_THRESHOLD)}`,
  `${String(shipped.false)} false of ${String(trials.length)} trials`,
);
check(
  shipped.missed === 0,
  "and every Person meco could recognise, it did",
  `${String(shipped.missed)} missed, ${String(shipped.correct)} correct`,
);

// Room on both sides, not merely a value that happens to work. A threshold
// sitting one hundredth from the first mistake is a number that will be wrong
// on the next photograph.
const belowSame = worstSame - MATCH_THRESHOLD;
const aboveDiffer = MATCH_THRESHOLD - bestDiffer;
check(
  belowSame > 0.1 && aboveDiffer > 0.1,
  "the threshold sits clear of both kinds of mistake",
  `${aboveDiffer.toFixed(4)} above the best stranger, ${belowSame.toFixed(4)} below the worst same-person pair`,
);

/**
 * The sweep's arithmetic and the service's are the same arithmetic.
 *
 * `decide` above exists so the sweep can move the threshold, and a
 * reimplementation that quietly disagreed with `matchFacePrint` would produce a
 * beautiful table about code nobody runs. So at the shipped operating point the
 * two are run side by side on every trial and must agree face by face.
 */
let disagreed = "";
for (const trial of trials) {
  const mine = decide(trial, MATCH_THRESHOLD, MATCH_MARGIN);
  const theirs = matchFacePrint(trial.face.print, trial.gallery);
  if ((mine?.personId ?? null) !== (theirs?.personId ?? null)) {
    disagreed = `${trial.face.name} against ${trial.label}`;
    break;
  }
}
check(
  disagreed === "",
  "the sweep decides exactly what src/people.ts decides",
  disagreed === "" ? `${String(trials.length)} trials agree` : disagreed,
);

// ---------------------------------------------------------- narrowing by name

/**
 * `persons` narrows the answer and can never widen it.
 *
 * Asked about Person A's face with only Person B named, the answer has to be
 * nobody — not B, who is the closest name on the list. That is the property that
 * keeps a Crop pinned to the wrong colleague, and it is one line in
 * `matchFacePrint` that a refactor could quietly turn into a filter over the
 * subset instead.
 */
{
  let wrong = "";
  let narrowed = 0;
  for (const face of faces) {
    const gallery = faces.filter((f) => f.name !== face.name).map(enrol);
    const open = matchFacePrint(face.print, gallery);
    if (!open) continue;
    for (const person of people) {
      const only = [`person-${person}`];
      const limited = matchFacePrint(face.print, gallery, only);
      if (limited === null) {
        narrowed++;
        continue;
      }
      if (limited.personId !== open.personId) wrong = `${face.name} became ${limited.personId}`;
    }
  }
  check(
    wrong === "",
    "naming Persons never produces a Match the open question did not",
    wrong === "" ? `${String(narrowed)} answers narrowed to nobody` : wrong,
  );
  check(narrowed > 0, "and it did narrow some", `${String(narrowed)} of them`);
}

// -------------------------------------------- the rule, on faces nobody has

/**
 * Two properties the fixture photographs cannot test, on Face Prints built to
 * order.
 *
 * Everything above is a measurement, and a measurement needs real faces or it
 * measures nothing. These two are not measurements — they assert that a rule is
 * applied at all, and the case each rule guards against does not exist in the
 * fixture set and would not be honest to fake in it. So they are built here, out
 * of arithmetic that says plainly what it is: unit vectors placed at a chosen
 * angle to one another, with no claim to be anybody's face.
 *
 * Both were found by mutation. `matchFacePrint` with the margin deleted, and
 * with `persons` filtering the gallery before the comparison instead of the
 * winner after it, each passed the entire suite — because no two people in the
 * fixtures look alike, which is exactly the situation both rules exist for.
 */
{
  /** A unit vector at `cosine` to the first basis direction. */
  const at = (cosine: number, axis: number): number[] => {
    const v = Array.from({ length: 512 }, () => 0);
    v[0] = cosine;
    v[axis] = Math.sqrt(1 - cosine * cosine);
    return v;
  };

  const query = at(1, 1);
  const person = (id: string, cosine: number, axis: number): EnrolledPrint => ({
    personId: id,
    personName: id,
    photoId: `${id}-1`,
    print: at(cosine, axis),
    printedAt: "2026-09-05T00:00:00.000Z",
  });

  // Two Persons of one Brand who look alike. Both well over the threshold and
  // two hundredths apart, which is inside the margin — so the honest answer is
  // that meco cannot tell them apart, not that the one ahead by a hundredth
  // takes the other one's place in a published picture.
  const alike = [person("close-a", 0.9, 1), person("close-b", 0.88, 2)];
  check(
    matchFacePrint(query, alike) === null,
    "two Persons inside the margin are told apart by neither",
    `0.90 against 0.88, margin ${String(MATCH_MARGIN)}`,
  );
  check(
    matchFacePrint(query, [alike[0]!])?.personId === "close-a",
    "and with only one of them enrolled the same face is a Match",
    "so the margin refuses a rival, not a score",
  );

  // The narrowing order. The face really belongs to the Person nobody named,
  // and it clears the threshold against the Person who was named. Comparing
  // against the named subset alone would put the wrong human's name on it.
  const two = [person("wanted", 0.6, 1), person("actual", 0.9, 2)];
  const narrowedTo = matchFacePrint(query, two, ["wanted"]);
  check(
    narrowedTo === null,
    "a face that is really somebody else is not handed to the Person who was named",
    narrowedTo === null ? "refused" : `named ${narrowedTo.personId}`,
  );
  check(
    matchFacePrint(query, two)?.personId === "actual",
    "though unnarrowed it is that other Person, so the trap is a real one",
    "0.90 against 0.60, both over the threshold",
  );
}

// ------------------------------------------------- what is not a face at all

/**
 * The other threshold, and the one issue #34 is about.
 *
 * `MATCH_THRESHOLD` answers "are these two prints the same person". It is only
 * meaningful for inputs that are people, and the whole of #34 is what happens
 * when one of them is not: EdgeFace maps every head with no face turned to the
 * camera close to every other one, so a helmet clears any threshold calibrated
 * on faces. Production enrolled the back of a crash helmet and then named a
 * different human as it, at 0.7092.
 *
 * `NOT_A_FACE_THRESHOLD` is the cut that stops it, and this is where it is
 * earned. The ground truth is a human's, in `fixtures/karts/expected.json`:
 * somebody looked at every detection at 2.2x its own box and said whether a
 * person could be named from it. The prints are EdgeFace's own, from
 * `fixtures/karts/face-prints.json`.
 *
 * Both mistakes are counted, and they are deliberately not weighted the same. A
 * face refused is blurred and unnamed — cautious. A Not-a-Face accepted is a
 * stranger's name on a published photograph, which is the bug. A refused face is
 * reported; an accepted Not-a-Face fails the run.
 */
{
  const KARTS = fileURLToPath(new URL("../fixtures/karts/", import.meta.url));

  interface KartPrint {
    file: string;
    index: number;
    label: string;
    is: "face" | "not-a-face";
    reference: boolean;
    person?: string;
    score: number;
    pixels: number;
    print: number[];
  }

  const { prints: karts } = JSON.parse(
    await readFile(`${KARTS}face-prints.json`, "utf8"),
  ) as { prints: KartPrint[] };
  const { images: kartDetections } = JSON.parse(
    await readFile(`${KARTS}detected.json`, "utf8"),
  ) as { images: Record<string, Detection> };
  const kartExpected = JSON.parse(await readFile(`${KARTS}expected.json`, "utf8")) as {
    images: { file: string; faces: { label: string; is: "face" | "not-a-face" }[] }[];
  };
  const faceDetections = JSON.parse(await readFile(`${FIXTURES}detected.json`, "utf8")) as {
    images: Record<string, Detection>;
  };
  const faceMarks = JSON.parse(await readFile(`${FIXTURES}expected.json`, "utf8")) as {
    images: { file: string; faces: { label: string; box: { x: number } }[] }[];
  };

  /**
   * How big each fixture face really is, in the frame `MIN_FACE_PX` judges.
   *
   * `face-prints.json` names a face by its label and `detected.json` records the
   * boxes, and neither carries the other's key. They are paired the way
   * `packages/faces/scripts/fixture-faces.ts` pairs them and the way
   * `scripts/http-probe.ts` does: both lists sorted left to right and zipped. No
   * two fixture faces are within the detector's tolerance of each other in x, so
   * the two orders cannot disagree.
   *
   * Measured rather than assumed, because the table below prints this number and
   * one of its checks cuts on it — a placeholder there would be a column that
   * looks like evidence and is not.
   */
  const facePixels = new Map<string, number>();
  for (const marked of faceMarks.images) {
    const detection = faceDetections.images[marked.file];
    if (!detection || detection.faces.length !== marked.faces.length) continue;
    const labels = [...marked.faces].sort((a, b) => a.box.x - b.box.x);
    const found = [...detection.faces].sort((a, b) => a.box.x - b.box.x);
    found.forEach((face, i) => {
      facePixels.set(
        `${marked.file}|${labels[i]!.label}`,
        Math.round(
          Math.min(face.box.width * detection.width, face.box.height * detection.height),
        ),
      );
    });
  }

  /**
   * The real detection behind one committed kart print.
   *
   * Reconstructed rather than approximated, because `whyNotIdentifiable` is asked
   * the same question the service asks it — the actual box, in the actual frame.
   * A synthesised face of the right size would test the rule against a shape the
   * detector never produces.
   */
  const detectionOf = (p: KartPrint): { face: DetectedFace; width: number; height: number } => {
    const image = kartDetections[p.file];
    const face = image?.faces[p.index];
    if (!image || !face) throw new Error(`${p.file}#${String(p.index)} is not in detected.json`);
    return { face, width: image.width, height: image.height };
  };

  /**
   * The face fixtures belong in this table too.
   *
   * They are the set `MATCH_THRESHOLD` was calibrated on, all of them
   * unmistakably faces, and a Not-a-Face rule that disturbed any of them would
   * be breaking the feature it is meant to protect. Nine more real faces for the
   * false-refusal count costs nothing and is the strongest guard here.
   */
  const everything: {
    name: string;
    is: "face" | "not-a-face";
    reference: boolean;
    pixels: number;
    print: number[];
    /** Null when the entry is a face fixture, whose detection is not recorded here. */
    detection: { face: DetectedFace; width: number; height: number } | null;
  }[] = [
    ...karts.map((p) => ({
      name: `${p.file.replace(".jpg", "")}#${String(p.index)} — ${p.label}`,
      is: p.is,
      reference: p.reference,
      pixels: p.pixels,
      print: p.print,
      detection: detectionOf(p),
    })),
    ...faces.map((f) => ({
      name: `${f.file.replace(".jpg", "")} — ${f.label}`,
      is: "face" as const,
      reference: false,
      pixels: facePixels.get(`${f.file}|${f.label}`) ?? 0,
      print: f.print,
      detection: null,
    })),
  ];

  /**
   * How alike this print is to the nearest committed Not-a-Face Print.
   *
   * A reference is never compared with itself: it scores 1.0000 and says nothing.
   * With one reference committed that leaves it unmeasured here, which is the
   * honest answer — `on-track-visor-open` and the man seen from behind are the
   * out-of-sample rejections, and they are what the threshold rests on.
   */
  const nearest = (entry: (typeof everything)[number]): number => {
    if (entry.reference) return Number.NaN;
    const resemblance = notAFace(entry.print);
    // `notAFace` only reports what clears the threshold, so anything below it has
    // to be measured directly for the table to show the distribution.
    return resemblance
      ? resemblance.score
      : Math.max(
          ...NOT_A_FACE_PRINTS.map((r) => cosineSimilarity(entry.print, r.print)),
        );
  };

  console.log(
    `\n${String(everything.length)} classified detections against ` +
      `${String(NOT_A_FACE_PRINTS.length)} committed Not-a-Face Print` +
      `${NOT_A_FACE_PRINTS.length === 1 ? "" : "s"}\n`,
  );
  console.log("nearest  px   verdict      what it is");
  const measured = everything
    .map((e) => ({ ...e, cosine: nearest(e) }))
    .sort((a, b) => (b.cosine || 0) - (a.cosine || 0));
  for (const e of measured) {
    const rule = e.detection
      ? whyNotIdentifiable(e.detection.face, e.print, e.detection.width, e.detection.height)
      : null;
    console.log(
      ` ${Number.isNaN(e.cosine) ? "  ref " : e.cosine.toFixed(4)}  ` +
        `${String(e.pixels).padStart(3)}  ${(rule === null ? "identity" : "refused").padEnd(11)} ` +
        `${e.is === "face" ? " " : "*"}${e.name}`,
    );
  }
  console.log("\n* = a human said there is no face there");

  /**
   * Detections the table cannot show, named rather than quietly dropped.
   *
   * A count that silently excludes what it could not measure is the shape of an
   * honest-looking wrong answer. `paddock-mixed#1` is a real face a human
   * classified, and it has no Face Print at all: the ArcFace warp cannot cut a
   * 112 px square from those landmarks, so `/embed` refuses it. It is not
   * evidence for or against the threshold and it is not a face meco can name —
   * and both of those are worth saying out loud.
   */
  const withoutAPrint = kartExpected.images.flatMap((image) =>
    image.faces.flatMap((marked, i) =>
      karts.some((p) => p.file === image.file && p.index === i)
        ? []
        : [`${image.file.replace(".jpg", "")}#${String(i)} — ${marked.label}`],
    ),
  );
  if (withoutAPrint.length > 0) {
    console.log(
      `\nnot in the table, because the warp could not cut a square from them:\n` +
        withoutAPrint.map((n) => `  ${n}`).join("\n"),
    );
  }
  console.log();

  // The two edges the threshold sits between. Only detections that clear the
  // size rule count: below it meco does not claim to recognise anyone, so a
  // 36 px face drifting towards a helmet is not what this threshold is for.
  const bigEnough = measured.filter(
    (e) => !e.reference && (e.detection === null || e.pixels >= MIN_FACE_PX),
  );
  const realFaces = bigEnough.filter((e) => e.is === "face");
  const notFaces = bigEnough.filter((e) => e.is === "not-a-face");
  const worstFace = Math.max(...realFaces.map((e) => e.cosine));
  const bestNotAFace = Math.min(...notFaces.map((e) => e.cosine));

  const band = bestNotAFace - worstFace;
  console.log(
    `real face, nearest a Not-a-Face Print gets   ${worstFace.toFixed(4)}` +
      `\nnot a face, furthest one gets                ${bestNotAFace.toFixed(4)}` +
      `\nband                                        ${band >= 0 ? `${worstFace.toFixed(4)} to ${bestNotAFace.toFixed(4)}, ${band.toFixed(4)} wide` : `${band.toFixed(4)} — INVERTED, the two populations overlap`}` +
      `, shipping ${NOT_A_FACE_THRESHOLD.toFixed(2)}\n`,
  );

  // The claim that decides the ticket. Counted through the shipped function, not
  // through a comparison reproduced here, so a rule that stopped being applied
  // fails this rather than passing a table about code nobody runs.
  const accepted = notFaces.filter((e) => {
    const d = e.detection!;
    return whyNotIdentifiable(d.face, e.print, d.width, d.height) === null;
  });
  check(
    accepted.length === 0,
    "nothing a human called a non-face is allowed to be an identity",
    accepted.length === 0
      ? `${String(notFaces.length)} refused, worst ${bestNotAFace.toFixed(4)}`
      : accepted.map((e) => e.name).join(", "),
  );

  const refusedFaces = realFaces.filter((e) => {
    if (!e.detection) return notAFace(e.print) !== null;
    const d = e.detection;
    return whyNotIdentifiable(d.face, e.print, d.width, d.height) !== null;
  });
  /**
   * The real faces this rule refuses, named — because at the size production
   * uses there is no threshold that refuses none of them.
   *
   * Issue #42. When the fixtures were committed at 1400 px this list was empty
   * and the check asserted so. That was a property of the fixtures, not of the
   * rule: `paddock-mixed#8` was 36 px there and `MIN_FACE_PX` refused it before
   * the print was ever consulted. At the 1600 px bound the same detection is
   * 40 px, clears the floor, and lands at 0.6542 — above the furthest non-face.
   * No value of `NOT_A_FACE_THRESHOLD` accepts it and still refuses
   * `paddock-mixed#7` at 0.6365.
   *
   * So the loss is real, it is recorded here by name, and it is the cheap
   * mistake of the two: a refused face is blurred and unnamed. Adding to this
   * list is a deliberate act with an ADR-0003 entry behind it, never a way to
   * make a red run green.
   */
  const REFUSED_ON_RECORD = ["paddock-mixed#8"];
  const refusedNames = refusedFaces.map(shortName).sort();
  check(
    refusedNames.join(",") === [...REFUSED_ON_RECORD].sort().join(","),
    "and the real faces it refuses are the ones on record",
    refusedFaces.length === 0
      ? `none, and ${String(REFUSED_ON_RECORD.length)} expected`
      : refusedFaces.map((e) => `${e.name} ${e.cosine.toFixed(4)}`).join(", "),
  );

  /**
   * Where the separation is clean, and where it is not.
   *
   * At 57 px and above the two populations are as far apart as
   * `MATCH_THRESHOLD`'s own. Everything tight about this threshold lives in the
   * 40–57 px band, and printing both numbers is what stops the ADR quoting the
   * comfortable one as if it covered the whole set.
   */
  const clearlyBigEnough = realFaces.filter((e) => e.pixels >= 57);
  const worstBigFace = Math.max(...clearlyBigEnough.map((e) => e.cosine));
  check(
    worstBigFace < 0.3 && bestNotAFace - worstBigFace > 0.3,
    "at 57 px and up the separation is as wide as the identity threshold's",
    `${String(clearlyBigEnough.length)} faces, closest ${worstBigFace.toFixed(4)}, ` +
      `${(bestNotAFace - worstBigFace).toFixed(4)} clear of the furthest non-face`,
  );

  /**
   * What 0.60 is, now that there is no band to sit in the middle of.
   *
   * The amendment to ADR-0003 described a threshold with room on both sides.
   * At the production bound that is no longer true and the honest claim is
   * narrower: 0.60 is **safe**, not centred. It refuses every non-face with
   * room to spare, and the price is the one face named above. Asserting the old
   * sentence here would be the same mistake #42 is about — a green check
   * standing for a property the numbers stopped having.
   */
  check(
    NOT_A_FACE_THRESHOLD < bestNotAFace,
    "the threshold refuses every non-face, with room to spare",
    `${(bestNotAFace - NOT_A_FACE_THRESHOLD).toFixed(4)} below the furthest non-face` +
      (band < 0 ? `, and ${Math.abs(band).toFixed(4)} of overlap with the closest real face` : ""),
  );

  /**
   * The size rule is not decoration, and this is the number that says so.
   *
   * `MIN_FACE_PX` was written for enrolment and now runs when matching too. On
   * these fixtures it changes no verdict — every face it refuses would have been
   * refused by the print or was never going to be named — so it would be easy to
   * mistake for a belt-and-braces line and delete.
   *
   * It is not. It is what leaves the print threshold any room at all. Below the
   * size rule a real face and a helmet converge: `paddock-mixed`'s 36 px child
   * reaches 0.6920 against the committed Not-a-Face Print, and the furthest
   * non-face is 0.6935. Without the size rule the band a threshold has to fit
   * inside is those two numbers, and nothing can be calibrated in it.
   */
  const tooSmall = measured.filter(
    (e) => !e.reference && e.detection !== null && e.pixels < MIN_FACE_PX,
  );
  /**
   * Which of the two rules is actually load-bearing — the whole of issue #42.
   *
   * At 1400 px four `paddock-mixed` faces sat under `MIN_FACE_PX`, and the size
   * rule looked like what kept the print threshold a band to sit in. At the
   * bound production applies, **`MIN_FACE_PX` excludes nothing here at all**:
   * every detection clears 40 px, and every non-face that gets refused is
   * refused by its print. That is worth an assertion rather than a comment,
   * because the tempting conclusion from the old numbers — "the size rule
   * catches those anyway, so the print threshold has slack" — is false, and
   * acting on it would loosen the only rule doing the work.
   */
  const refusedForSize = notFaces.filter((e) => {
    const d = e.detection;
    if (!d) return false;
    const why = whyNotIdentifiable(d.face, e.print, d.width, d.height);
    return why !== null && why.includes("px");
  });
  check(
    refusedForSize.length === 0 && notFaces.every((e) => notAFace(e.print) !== null),
    "the print rule is what refuses the non-faces, not the size rule",
    `${String(notFaces.length)} non-faces, ${String(refusedForSize.length)} of them refused on size, ` +
      `${String(tooSmall.length)} detections in the whole set under ${String(MIN_FACE_PX)} px`,
  );

  /**
   * The collision issue #42 was filed about — and what re-deriving the fixture
   * did to the ticket's own numbers.
   *
   * The ticket asked for two `paddock-mixed` cross-person pairs at **0.6489 and
   * 0.5126** to be asserted at production resolution. **Neither reproduces**,
   * and that is recorded here rather than quietly worked around. Those figures
   * were measured on a re-encode made while investigating, not on the file now
   * committed; against these bytes the only pair over `MATCH_THRESHOLD` is
   * `#6`/`#7` at 0.5628. ADR-0003 puts JPEG drift at about 0.019 and this is
   * 0.086, so the encode explains part of it and the rest is that the pair set
   * at the margin is not stable. A number measured on bytes nobody committed is
   * not a number this suite can hold.
   *
   * What survives is the structural claim, which is the one that matters: at the
   * size production sends, two detections that are **not the same human** agree
   * well enough to clear `MATCH_THRESHOLD`, and the Not-a-Face rule is what
   * stops that becoming a name. Note what the pair is: `#7` is classified
   * not-a-face, so this is a face agreeing with a non-face rather than two
   * faces. There is **no face-to-face pair over the threshold** in this set —
   * asserting one would be asserting something the committed data does not
   * contain.
   *
   * `MIN_FACE_PX` cannot be the thing separating them: every detection here
   * clears it, which the check above asserts.
   */
  const paddock = bigEnough.filter((e) => e.name.startsWith("paddock-mixed#"));
  const collisions = paddock.flatMap((a, i) =>
    paddock.slice(i + 1).flatMap((b) => {
      const together = cosineSimilarity(a.print, b.print);
      return together >= MATCH_THRESHOLD ? [{ a, b, together }] : [];
    }),
  );
  const unguarded = collisions.filter(
    ({ a, b }) => notAFace(a.print) === null && notAFace(b.print) === null,
  );
  check(
    collisions.length > 0 && unguarded.length === 0,
    "detections that agree at this size are separated by the Not-a-Face rule",
    collisions.length === 0
      ? `no pair over ${String(MATCH_THRESHOLD)} — this fixture has stopped exercising the case #42 was filed about`
      : collisions
          .map(({ a, b, together }) => `${shortName(a)}/${shortName(b)} ${together.toFixed(4)}`)
          .join(", "),
  );

  /**
   * How far the threshold sits below the nearest helmet meco has ever been shown.
   *
   * This check used to assert `NOT_A_FACE_THRESHOLD <= 0.639`, the smallest of
   * the research document's 36 helmet-to-helmet pairs. That is **the wrong
   * quantity**, and it is the one #40 was raised about: the rule scores a
   * candidate against *one committed reference*, and a minimum over pairs
   * between other helmets says nothing on its own about the distance to that
   * reference. 0.639 turned out to belong to a pair the reference is not part
   * of, so the check was carrying a number nothing here verified — with the
   * authority of a green test, which is what people trust when they move a
   * constant.
   *
   * #43 measured the real thing: the shipped reference against the other eight
   * of the nine, **0.7092 to 0.9629, eight of eight caught**. Two of the nine
   * are CC0 and both are already committed; the other seven are CC BY-SA and
   * cannot join them under `fixtures/karts/LICENCE.md`. So that measurement
   * cannot be recomputed here, and what follows splits into the part that can
   * be checked and the part that is quoted — labelled, so no unverified number
   * sits in the gate wearing the same clothes as a measured one.
   */
  const WORST_OF_THE_NINE = 0.7092;
  const ENCODE_NOISE = 0.019;

  /**
   * The one of those eight that is committed, against the figure recorded for it.
   *
   * One number and one constant, because they are one measurement:
   * `on-track-visor-open` is both the nearest of the eight to the reference —
   * which is what makes 0.7092 the worst of them — and the only one of the eight
   * committed here. Naming it twice would let a future edit to the research
   * update one and leave the other silently stale.
   *
   * Asserting `NOT_A_FACE_THRESHOLD < 0.7092` on its own would be theatre: it is
   * strictly weaker than the `NOT_A_FACE_THRESHOLD < bestNotAFace` above, at
   * 0.6935, so nothing could ever trip it that has not already failed. These two
   * can fail. The first says the committed encode is the *conservative* one, so
   * the fixtures are not flattering the threshold; the second says the two
   * readings of the same pixels still agree, within the 0.019 ADR-0003 measured
   * a print moving across JPEG encodes. Between them a fixture re-encode that
   * drifted, or a research figure that moved, reddens the gate.
   */
  const visorOpen = measured.find((e) => e.name.startsWith("on-track-visor-open"));
  check(
    visorOpen !== undefined && visorOpen.cosine <= WORST_OF_THE_NINE,
    "recorded, not measured here: the committed encode is the conservative reading",
    visorOpen
      ? `${visorOpen.cosine.toFixed(4)} committed against ${WORST_OF_THE_NINE.toFixed(4)} in ` +
        "docs/research/kart-and-driver-subjects.md, the worst of the eight — seven of the " +
        "nine are CC BY-SA and cannot be committed, so that figure is quoted, not measured"
      : "on-track-visor-open is not in the table",
  );
  check(
    visorOpen !== undefined && Math.abs(visorOpen.cosine - WORST_OF_THE_NINE) <= ENCODE_NOISE,
    "and the two readings of that pair agree within what a JPEG encode moves",
    visorOpen
      ? `${Math.abs(visorOpen.cosine - WORST_OF_THE_NINE).toFixed(4)} apart, against ` +
        `${ENCODE_NOISE.toFixed(3)} of encode noise`
      : "on-track-visor-open is not in the table",
  );

  // Which way the threshold can move, and how far, said as movement rather than
  // as a band — a band reads as symmetric and this one is not. The binding
  // constraint is real faces, the opposite of what the old 0.639 row implied.
  check(
    bestNotAFace - NOT_A_FACE_THRESHOLD > NOT_A_FACE_THRESHOLD - worstFace,
    "and the tight side is real faces, not helmets",
    `${(bestNotAFace - NOT_A_FACE_THRESHOLD).toFixed(4)} of room above, ` +
      `${(NOT_A_FACE_THRESHOLD - worstFace).toFixed(4)} below`,
  );

  /**
   * Why the gallery is filtered and not only the detection.
   *
   * A helmet detection against a real enrolled Person is already safe — the
   * research measured helmet against face at 0.433 at worst over 108 pairs,
   * under `MATCH_THRESHOLD`. The dangerous direction is the other one, and it is
   * measurable right here: a real face in the paddock scores over 0.50 against
   * the committed helmet print. With that print in a Brand's gallery, meco would
   * put "Helmet A" on a real human — which no check on the *detection* can stop,
   * because the detection is a face and passes.
   */
  const enrolledHelmet: EnrolledPrint = {
    personId: "helmet-a",
    personName: "Helmet A",
    photoId: "the committed Not-a-Face Print",
    print: [...NOT_A_FACE_PRINTS[0]!.print],
    printedAt: "2026-09-05T00:00:00.000Z",
  };
  const namedByAHelmet = realFaces.filter(
    (e) => matchFacePrint(e.print, [enrolledHelmet]) !== null,
  );
  check(
    namedByAHelmet.length > 0,
    "a real face does clear MATCH_THRESHOLD against an enrolled helmet, so the trap is real",
    namedByAHelmet.map((e) => `${e.name} ${e.cosine.toFixed(4)}`).join(", ") || "none — check this",
  );
  check(
    notAFace(enrolledHelmet.print) !== null,
    "and matchFaces drops that Reference Photo before anything is compared against it",
    "so the Brand that enrolled a helmet before this rule existed is safe too",
  );

  /**
   * The check issue #34 actually asked for, measured rather than dismissed.
   *
   * The ticket proposed a geometry sanity check on YuNet's five points — "a real
   * face has eyes above a nose above a mouth, roughly symmetric, in plausible
   * proportion. On the back of a helmet those points are arbitrary." They are
   * not arbitrary, and that is the whole reason this file calibrates a print
   * threshold instead. The verdict is load-bearing, so it is recomputed here
   * from the committed landmarks rather than left as a sentence in a comment
   * that nothing would notice going stale.
   *
   * Two of the ticket's own axes, in a frame normalised by the distance between
   * the eyes so that size and roll fall out: how far off-centre the nose sits
   * between the two eyes, and how far the mouth drops below them. The claim is
   * not that the helmet looks normal — it is the stronger and more damning one
   * that the helmet is **interior** to the real faces on both axes, so a cutoff
   * in either direction reaches a real face before it reaches the helmet.
   */
  {
    interface Geometry {
      name: string;
      is: "face" | "not-a-face";
      /** |dist(nose, right eye) − dist(nose, left eye)|, in eye-widths. */
      asymmetry: number;
      /** How far the mouth's midpoint sits below the eye line, in eye-widths. */
      mouthDrop: number;
    }

    const geometryOf = (name: string, is: Geometry["is"], face: DetectedFace, w: number, h: number): Geometry => {
      const at = (p: { x: number; y: number }) => ({ x: p.x * w, y: p.y * h });
      const { rEye, lEye, nose, rMouth, lMouth } = face.landmarks;
      const [r, l, n, rm, lm] = [at(rEye), at(lEye), at(nose), at(rMouth), at(lMouth)];
      const gap = Math.hypot(l.x - r.x, l.y - r.y);
      const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        Math.hypot(a.x - b.x, a.y - b.y);
      // The eye line as an axis, so "below" means below the face rather than
      // below the photograph — a head tilted 30 degrees is still a head.
      const down = { x: -(l.y - r.y) / gap, y: (l.x - r.x) / gap };
      const eyes = { x: (r.x + l.x) / 2, y: (r.y + l.y) / 2 };
      const mouth = { x: (rm.x + lm.x) / 2, y: (rm.y + lm.y) / 2 };
      return {
        name,
        is,
        asymmetry: Math.abs(away(n, r) - away(n, l)) / gap,
        mouthDrop: ((mouth.x - eyes.x) * down.x + (mouth.y - eyes.y) * down.y) / gap,
      };
    };

    const geometry: Geometry[] = [];
    for (const image of kartExpected.images) {
      const detection = kartDetections[image.file];
      if (!detection) continue;
      image.faces.forEach((marked, i) => {
        const face = detection.faces[i];
        if (face) {
          geometry.push(
            geometryOf(
              `${image.file.replace(".jpg", "")}#${String(i)}`,
              marked.is,
              face,
              detection.width,
              detection.height,
            ),
          );
        }
      });
    }
    for (const [file, detection] of Object.entries(faceDetections.images)) {
      detection.faces.forEach((face, i) => {
        geometry.push(
          geometryOf(`${file.replace(".jpg", "")}#${String(i)}`, "face", face, detection.width, detection.height),
        );
      });
    }

    const helmet = geometry.find((g) => g.name === "on-track-rear-helmet#0");
    const realFaces = geometry.filter((g) => g.is === "face");
    if (!helmet || realFaces.length < 5) {
      check(false, "the landmark check has the fixtures to be measured on", "missing detections");
    } else {
      const interior = (axis: keyof Pick<Geometry, "asymmetry" | "mouthDrop">) => {
        const values = realFaces.map((g) => g[axis]);
        const above = realFaces.filter((g) => g[axis] > helmet[axis]);
        const below = realFaces.filter((g) => g[axis] < helmet[axis]);
        return {
          ok: above.length > 0 && below.length > 0,
          detail:
            `helmet ${helmet[axis].toFixed(3)}, real faces ${Math.min(...values).toFixed(3)} to ` +
            `${Math.max(...values).toFixed(3)} — ${String(above.length)} above it, ` +
            `${String(below.length)} below`,
        };
      };
      for (const axis of ["asymmetry", "mouthDrop"] as const) {
        const verdict = interior(axis);
        check(
          verdict.ok,
          `landmark ${axis} cannot separate the helmet: it is interior to the real faces`,
          verdict.detail,
        );
      }
    }
  }

  /**
   * The identity the kart fixtures do have.
   *
   * The same driver at two events with his helmet off. It is the only real
   * same-person pair outside `fixtures/faces/`, and it is the thing the whole
   * rule must leave alone: if the Not-a-Face check reached this far it would be
   * refusing exactly the customer it exists to serve.
   */
  const podium = karts.filter((p) => p.person === "A");
  if (podium.length !== 2) {
    check(false, "the kart fixtures hold the same driver twice", `${String(podium.length)} found`);
  } else {
    const [a, b] = podium as [KartPrint, KartPrint];
    const together = cosineSimilarity(a.print, b.print);
    check(
      together > MATCH_THRESHOLD &&
        matchFacePrint(b.print, [
          {
            personId: "driver",
            personName: "Kart Driver",
            photoId: a.file,
            print: a.print,
            printedAt: "2026-09-05T00:00:00.000Z",
          },
        ]) !== null,
      "the same driver at two events is still one Person",
      `${together.toFixed(4)} against a threshold of ${String(MATCH_THRESHOLD)}`,
    );
  }
}

console.log(`\n${problems.length === 0 ? "MATCH OK" : `${String(problems.length)} FAILED`}`);
if (problems.length > 0) process.exitCode = 1;
