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

import {
  MATCH_MARGIN,
  MATCH_THRESHOLD,
  cosineSimilarity,
  matchFacePrint,
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

const shipped = sweep(MATCH_THRESHOLD, MATCH_MARGIN);

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

console.log(`\n${problems.length === 0 ? "MATCH OK" : `${String(problems.length)} FAILED`}`);
if (problems.length > 0) process.exitCode = 1;
