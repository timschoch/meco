/**
 * The identity calibration, recomputed in the gate.
 *
 * ADR-0003 chose `MATCH_THRESHOLD` and ADR-0012 inherited it. The numbers
 * behind it are not a claim in a document here: this file recomputes them from
 * `fixtures/faces/face-prints.json` every run, prints the table, and goes red
 * on a single stranger pair that would be named. It replaces the identity half
 * of the prototype's `scripts/match-calibration.ts`.
 *
 * No model, no network, no database: the prints are committed and the sweep is
 * arithmetic over them.
 *
 * **Measured on the shipped Enricher, 6 Sep 2026 (#177).** Both fixture print
 * files are re-taken by `pnpm --filter @meco/models print:fixtures` through the
 * Catalogue's own `edgeface/1` at the Decode Bound, and the provenance each
 * file records is asserted below — a print from another Model or another bound
 * fails the run rather than being swept. Every row moved by less than 0.0006
 * against the prototype's ONNX path, so both bands are the inherited ones and
 * no constant moved. ADR-0012, Decision 3 carries the table with its deltas.
 */
import { describe, expect, it } from "vitest";
import { DECODE_BOUND } from "@meco/models";
import {
  MATCH_MARGIN,
  MATCH_THRESHOLD,
  MIN_FACE_PX,
  NOT_A_FACE_PRINTS,
  NOT_A_FACE_THRESHOLD,
  PRINT_MODEL,
} from "../index";
import {
  cosine,
  facePrints,
  facePrintsPrintedBy,
  kartPrints,
  kartPrintsPrintedBy,
  type PrintedBy,
  printPairs,
} from "./fixtures";

/**
 * How far a re-measured row may sit from the number asserted here before the
 * run goes red. Four decimals: tighter than that is floating-point noise
 * between two runs of the same weights, and looser would let a print path
 * change slip through the band it is supposed to be checking.
 */
const DECIMALS = 4;

const worst = (of: readonly { similarity: number }[]) =>
  of.reduce(
    (low, one) => Math.min(low, one.similarity),
    Number.POSITIVE_INFINITY
  );

const best = (of: readonly { similarity: number }[]) =>
  of.reduce(
    (high, one) => Math.max(high, one.similarity),
    Number.NEGATIVE_INFINITY
  );

/** The provenance line every table is printed under. */
const provenance = (file: string, by: PrintedBy): string =>
  `${file} — ${by.model.name}/${by.model.version} at the ${by.bound} px Decode Bound, onnxruntime ${by.onnxruntime}`;

/**
 * The Model and the bound both fixture files must have been printed at.
 *
 * Asserted before any table is read: `MATCH_THRESHOLD` and
 * `NOT_A_FACE_THRESHOLD` are properties of one network at one size, and a
 * sweep over prints from another would reproduce nothing while still passing
 * every band check by arithmetic. This is the check that makes the recorded
 * provenance load-bearing rather than a comment.
 */
describe("both fixture print files come from the Print Model at the bound", () => {
  for (const [file, by] of [
    ["fixtures/faces/face-prints.json", facePrintsPrintedBy()],
    ["fixtures/karts/face-prints.json", kartPrintsPrintedBy()],
  ] as const) {
    it(`${file} was printed by the Print Model`, () => {
      expect(by.model).toEqual(PRINT_MODEL);
      expect(by.bound).toBe(DECODE_BOUND);
    });
  }
});

describe("the identity calibration on the committed fixture prints", () => {
  const { samePerson, strangers } = printPairs();
  const by = facePrintsPrintedBy();

  it("recomputes ADR-0012's table and leaves the band open", () => {
    const sameWorst = worst(samePerson);
    const strangerBest = best(strangers);

    console.log(
      [
        `identity calibration — ${provenance("fixtures/faces/face-prints.json", by)}`,
        `  same-person pairs   ${samePerson.length}, worst ${sameWorst.toFixed(4)}`,
        `  stranger pairs      ${strangers.length}, best  ${strangerBest.toFixed(4)}`,
        `  clean band          ${(sameWorst - strangerBest).toFixed(4)} wide, around a threshold of ${MATCH_THRESHOLD}`,
      ].join("\n")
    );

    // ADR-0003 Decision 3, re-measured 6 Sep 2026 on the shipped Enricher.
    expect(samePerson).toHaveLength(3);
    expect(strangers).toHaveLength(33);
    expect(sameWorst).toBeCloseTo(0.7263, DECIMALS);
    expect(strangerBest).toBeCloseTo(0.2978, DECIMALS);

    // The threshold sits inside the band with room on both sides, which is the
    // whole reason 0.50 is allowed to be a chosen number rather than a fitted
    // one.
    expect(strangerBest).toBeLessThan(MATCH_THRESHOLD);
    expect(sameWorst).toBeGreaterThan(MATCH_THRESHOLD);
  });

  it("names no stranger at the threshold", () => {
    const named = strangers.filter((one) => one.similarity >= MATCH_THRESHOLD);
    // One false Match is the failure this whole module exists to prevent, so
    // one is enough to fail the run.
    expect(named).toEqual([]);
  });

  it("keeps every same-person pair clear of every stranger by the margin", () => {
    // The margin is a chosen number: the fixtures hold no look-alikes, so this
    // check says the fixtures cannot embarrass it, not that 0.05 is measured.
    const clearance = worst(samePerson) - best(strangers);
    expect(clearance).toBeGreaterThan(MATCH_MARGIN);
  });
});

/**
 * The margin table: what `MATCH_MARGIN` would actually decide on this fixture
 * set, scored the way the rule scores — best similarity per Person, with the
 * runner-up the best *other* Person, and a face never scored against itself.
 *
 * It is printed because "0.05 is chosen, not measured" is easy to write and
 * easy to stop believing. The table is what makes it checkable.
 */
describe("the margin table on the committed fixture prints", () => {
  const prints = facePrints();
  const people = [...new Set(prints.map((one) => one.person))];

  /** Every face's best Person and its runner-up, worst margin first. */
  const scored = prints
    .map((face) => {
      const perPerson = people
        .map((person) => ({
          person,
          similarity: prints
            .filter((one) => one.person === person && one !== face)
            .reduce(
              (high, one) => Math.max(high, cosine(face.print, one.print)),
              Number.NEGATIVE_INFINITY
            ),
        }))
        .filter((one) => Number.isFinite(one.similarity))
        .sort((a, b) => b.similarity - a.similarity);
      const top = perPerson[0]!;
      const runnerUp = perPerson[1]!;
      return {
        id: `${face.file} ${face.label}`,
        is: face.person,
        top,
        runnerUp,
        margin: top.similarity - runnerUp.similarity,
        named: top.similarity >= MATCH_THRESHOLD,
      };
    })
    .sort((a, b) => a.margin - b.margin);

  it("shows the margin decides nothing here, and says why", () => {
    const named = scored.filter((one) => one.named);
    const refused = scored.filter((one) => !one.named);

    console.log(
      [
        `margin table — ${provenance("fixtures/faces/face-prints.json", facePrintsPrintedBy())}`,
        `  threshold ${MATCH_THRESHOLD}, margin ${MATCH_MARGIN}`,
        ...scored.map(
          (one) =>
            `  ${one.named ? "named  " : "refused"} ${one.id} (person ${one.is}) — best ${one.top.similarity.toFixed(4)} to ${one.top.person}, runner-up ${one.runnerUp.similarity.toFixed(4)} to ${one.runnerUp.person}, margin ${one.margin.toFixed(4)}`
        ),
        `  worst margin among the ${named.length} faces that reach the threshold  ${worst(named.map((one) => ({ similarity: one.margin }))).toFixed(4)}`,
        `  worst margin among the ${refused.length} that do not                    ${worst(refused.map((one) => ({ similarity: one.margin }))).toFixed(4)}`,
        "  flat: the margin is never the check that decides a fixture face.",
      ].join("\n")
    );

    // Every face that reaches the threshold is the Person it is, and clears
    // the runner-up by ten times the margin. Nothing here is near 0.05.
    expect(named).toHaveLength(3);
    for (const one of named) {
      expect(one.top.person).toBe(one.is);
      expect(one.margin).toBeGreaterThan(MATCH_MARGIN * 10);
    }
    expect(worst(named.map((one) => ({ similarity: one.margin })))).toBeCloseTo(
      0.5251,
      DECIMALS
    );

    // And the faces with a margin under 0.05 — down to 0.0005 — are the six
    // single-print Persons, each refused by the threshold long before the
    // margin is consulted. That is the whole reason 0.05 stays a chosen
    // number: this fixture set gives it nothing to be measured against.
    expect(refused).toHaveLength(6);
    for (const one of refused) {
      expect(one.top.similarity).toBeLessThan(MATCH_THRESHOLD);
    }
    expect(
      worst(refused.map((one) => ({ similarity: one.margin })))
    ).toBeCloseTo(0.0005, DECIMALS);
  });
});

/**
 * The Not-a-Face calibration, recomputed in the gate.
 *
 * ADR-0003's amendment measured `NOT_A_FACE_THRESHOLD` over the kart fixtures,
 * whose ground truth is a human's classification of every detection
 * (`fixtures/karts/expected.json`). This half of the file recomputes that
 * table, asserts the exact set of detections 0.60 refuses, and fails the run on
 * a non-face it accepts.
 *
 * The band here is negative: 0.60 refuses every non-face with 0.0364 to spare
 * and refuses one real face by 0.0181 as the price. Asserting the exact set and
 * not "there is none" is what makes refusing a *different* face a failure.
 */
describe("the Not-a-Face calibration on the committed kart prints", () => {
  const reference = NOT_A_FACE_PRINTS;
  const by = kartPrintsPrintedBy();

  /** Every classified detection with a print, against the reference set. */
  const measured = kartPrints()
    .filter((one) => !one.reference)
    .map((one) => ({
      id: one.id,
      is: one.is,
      pixels: one.pixels,
      nearest: reference.reduce(
        (high, print) => Math.max(high, cosine(one.vector, print.vector)),
        Number.NEGATIVE_INFINITY
      ),
    }))
    .sort((a, b) => b.nearest - a.nearest);

  it("commits exactly the prints the fixtures mark as the reference set", () => {
    const marked = kartPrints().filter((one) => one.reference);
    expect(reference.map((one) => one.id)).toEqual(marked.map((one) => one.id));
    for (const [index, print] of reference.entries()) {
      // Byte-equal, not merely close: the committed file is a copy of the
      // fixture print, so re-printing the fixtures and forgetting to run
      // `generate:not-a-face-prints` fails the gate instead of shipping a
      // reference from the previous Enricher.
      expect(print.vector).toEqual([...(marked[index]?.vector ?? [])]);
      expect(print.saw).toBe(marked[index]?.saw);
    }
  });

  it("recomputes ADR-0003's table and shows the band is closed", () => {
    const faces = measured.filter((one) => one.is === "face");
    const nonFaces = measured.filter((one) => one.is === "not-a-face");
    // The real face nearest the reference: the one the threshold has to refuse
    // as its price. And the non-face *furthest* from it, which is the one that
    // decides how much room the threshold has — a non-face nearer the
    // reference is easier to refuse, not harder. ADR-0003's table calls this
    // row "nearest non-face"; it is the binding one either way.
    const nearestFace = faces[0];
    const furthestNonFace = nonFaces[nonFaces.length - 1];
    const heldOut = measured.find(
      (one) => one.id === "on-track-visor-open.jpg#0"
    );
    if (
      nearestFace === undefined ||
      furthestNonFace === undefined ||
      heldOut === undefined
    ) {
      throw new Error(
        "the kart fixtures lost a face, a non-face or the held-out helmet"
      );
    }

    console.log(
      [
        `not-a-face calibration — ${provenance("fixtures/karts/face-prints.json", by)}, ${reference.length} reference print(s)`,
        `  classified detections  ${measured.length} (${faces.length} faces, ${nonFaces.length} non-faces), every one over the ${MIN_FACE_PX} px floor`,
        `  nearest non-face       ${furthestNonFace.nearest.toFixed(4)} — ${furthestNonFace.id}, ${furthestNonFace.pixels} px`,
        `  nearest real face      ${nearestFace.nearest.toFixed(4)} — ${nearestFace.id}, ${nearestFace.pixels} px`,
        `  held out of the set    ${heldOut.nearest.toFixed(4)} — ${heldOut.id}, ${heldOut.pixels} px`,
        `  threshold              ${NOT_A_FACE_THRESHOLD}`,
        `  clearance below the nearest non-face  ${(furthestNonFace.nearest - NOT_A_FACE_THRESHOLD).toFixed(4)}`,
        `  band                   ${(furthestNonFace.nearest - nearestFace.nearest).toFixed(4)} — there is none`,
      ].join("\n")
    );

    // The size of the sweep, asserted so that a fixture gaining or losing a
    // print is loud. ADR-0003's amendment says "21 hand-classified
    // detections" and "11 real faces of 57 px or more"; the fixture files hold
    // 13 classified detections, 12 printed, 11 swept past the reference, and 9
    // of those are real faces. Those counts are stale rather than a different
    // measurement — the three headline cosines reproduce — and ADR-0012 says
    // so with its date.
    expect(measured).toHaveLength(11);
    expect(faces).toHaveLength(9);
    expect(nonFaces).toHaveLength(2);

    // ADR-0003's amendment, re-measured 6 Sep 2026 on the shipped Enricher.
    expect(furthestNonFace.id).toBe("paddock-mixed.jpg#7");
    expect(furthestNonFace.nearest).toBeCloseTo(0.6364, DECIMALS);
    expect(nearestFace.id).toBe("paddock-mixed.jpg#8");
    expect(nearestFace.nearest).toBeCloseTo(0.6545, DECIMALS);
    // Both rejections are out of sample. The held-out second helmet is the
    // one that says the rule generalises past its own reference photograph.
    expect(heldOut.nearest).toBeCloseTo(0.6933, DECIMALS);
    expect(furthestNonFace.nearest - NOT_A_FACE_THRESHOLD).toBeCloseTo(
      0.0364,
      DECIMALS
    );
    // The real face is nearer the reference than that non-face is: no value of
    // the threshold accepts it and still refuses the non-face. The band is
    // negative, and 0.60 is safe rather than centred.
    expect(furthestNonFace.nearest - nearestFace.nearest).toBeCloseTo(
      -0.0181,
      DECIMALS
    );
    // Every detection in the sweep clears the size floor, so the floor is not
    // silently doing the Not-a-Face rule's work.
    for (const one of measured) {
      expect(one.pixels).toBeGreaterThanOrEqual(MIN_FACE_PX);
    }
  });

  it("refuses every non-face, and exactly one real face as the price", () => {
    const refused = measured
      .filter((one) => one.nearest >= NOT_A_FACE_THRESHOLD)
      .map((one) => one.id);

    // The exact set, not "no non-face is accepted": refusing a different face
    // is a change in behaviour and has to fail the run.
    expect(refused).toEqual([
      // Held out of the reference set on purpose, so this rejection is out of
      // sample: a second driver's helmet, visor up.
      "on-track-visor-open.jpg#0",
      // A small child looking down, 40 px. The cautious mistake, named.
      "paddock-mixed.jpg#8",
      // A man seen from behind. The rejection the rule exists for.
      "paddock-mixed.jpg#7",
    ]);

    const accepted = measured.filter(
      (one) => one.nearest < NOT_A_FACE_THRESHOLD
    );
    // A non-face that keeps its identity is the failure of issue #34.
    expect(accepted.filter((one) => one.is === "not-a-face")).toEqual([]);
    // Six of paddock-mixed's seven real faces stay matchable, and both podium
    // photographs with them.
    expect(accepted.map((one) => one.id)).toEqual([
      "paddock-mixed.jpg#4",
      "paddock-mixed.jpg#6",
      "paddock-mixed.jpg#5",
      "paddock-mixed.jpg#2",
      "podium-trophy-2.jpg#0",
      "podium-trophy.jpg#0",
      "paddock-mixed.jpg#0",
      "paddock-mixed.jpg#3",
    ]);
    expect(
      accepted.filter((one) => one.id.startsWith("paddock-mixed.jpg"))
    ).toHaveLength(6);
  });
});
