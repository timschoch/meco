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

import type { DetectedFace, Detection } from "../src/faces.js";
import { NOT_A_FACE_PRINTS } from "../src/not-a-face-prints.js";
import {
  MATCH_MARGIN,
  MATCH_THRESHOLD,
  MIN_FACE_PX,
  NOT_A_FACE_THRESHOLD,
  cosineSimilarity,
  matchFacePrint,
  notAFace,
  whyNotAnIdentity,
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

/** One face enrolled for one Person, in the shape the store hands matching. */
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

  /**
   * The real detection behind one committed kart print.
   *
   * Reconstructed rather than approximated, because `whyNotAnIdentity` is asked
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
      // Every fixture face is far above the size rule; `pnpm test:detect` holds
      // the boxes those numbers come from. Recorded as the rule's own floor so
      // this table never claims a measurement it did not make.
      pixels: MIN_FACE_PX,
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
      ? whyNotAnIdentity(e.detection.face, e.print, e.detection.width, e.detection.height)
      : null;
    console.log(
      ` ${Number.isNaN(e.cosine) ? "  ref " : e.cosine.toFixed(4)}  ` +
        `${String(e.pixels).padStart(3)}  ${(rule === null ? "identity" : "refused").padEnd(11)} ` +
        `${e.is === "face" ? " " : "*"}${e.name}`,
    );
  }
  console.log("\n* = a human said there is no face there\n");

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

  console.log(
    `real face, nearest a Not-a-Face Print gets   ${worstFace.toFixed(4)}` +
      `\nnot a face, furthest one gets                ${bestNotAFace.toFixed(4)}` +
      `\nband                                        ${worstFace.toFixed(4)} to ` +
      `${bestNotAFace.toFixed(4)}, shipping ${NOT_A_FACE_THRESHOLD.toFixed(2)}\n`,
  );

  // The claim that decides the ticket. Counted through the shipped function, not
  // through a comparison reproduced here, so a rule that stopped being applied
  // fails this rather than passing a table about code nobody runs.
  const accepted = notFaces.filter((e) => {
    const d = e.detection!;
    return whyNotAnIdentity(d.face, e.print, d.width, d.height) === null;
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
    return whyNotAnIdentity(d.face, e.print, d.width, d.height) !== null;
  });
  check(
    refusedFaces.length === 0,
    "and no real face big enough to recognise is refused",
    refusedFaces.length === 0
      ? `${String(realFaces.length)} accepted, closest ${worstFace.toFixed(4)}`
      : refusedFaces.map((e) => `${e.name} ${e.cosine.toFixed(4)}`).join(", "),
  );

  check(
    NOT_A_FACE_THRESHOLD > worstFace && NOT_A_FACE_THRESHOLD < bestNotAFace,
    "the threshold sits inside the band both kinds of mistake leave open",
    `${(NOT_A_FACE_THRESHOLD - worstFace).toFixed(4)} above the closest real face, ` +
      `${(bestNotAFace - NOT_A_FACE_THRESHOLD).toFixed(4)} below the furthest non-face`,
  );

  /**
   * The floor an unseen helmet has to be caught below.
   *
   * `docs/research/kart-and-driver-subjects.md` measured nine helmets over 36
   * pairs and the worst two agreed at 0.639. Any helmet is therefore at least
   * that alike to the committed one, and a threshold above 0.639 would let the
   * least typical helmet through. This is the one number here that comes from
   * outside the committed fixtures, and it is the reason the threshold is not
   * simply pushed up to buy more room on the false-refusal side.
   */
  const WORST_HELMET_PAIR = 0.639;
  check(
    NOT_A_FACE_THRESHOLD <= WORST_HELMET_PAIR,
    "and below the worst helmet-to-helmet pair the research measured, over 36 pairs",
    `${NOT_A_FACE_THRESHOLD.toFixed(2)} against ${WORST_HELMET_PAIR.toFixed(3)}`,
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
