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
 * **Inherited, not yet verified against the shipped adapter.** Every print here
 * came from the prototype's ONNX path, and #121 asks the new Enricher only for
 * cosine 0.95 against them. The re-calibration ticket regenerates the fixture
 * prints through the shipped adapter and edits ADR-0012's table; until then
 * this file asserts the inherited numbers on the inherited prints.
 */
import { describe, expect, it } from "vitest";
import {
  MATCH_MARGIN,
  MATCH_THRESHOLD,
  MIN_FACE_PX,
  NOT_A_FACE_PRINTS,
  NOT_A_FACE_THRESHOLD,
} from "../index";
import { kartPrints, printPairs } from "./fixtures";

/**
 * The bound the fixture photographs were committed at, and the size every
 * print here was taken at (`docs/specs/models.md`, "Decode once"). A number
 * without what it was measured on is a trap, so it is printed with the table.
 */
const MEASURED_AT_PX = 1600;

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

describe("the identity calibration on the committed fixture prints", () => {
  const { samePerson, strangers } = printPairs();

  it("recomputes ADR-0012's table and leaves the band open", () => {
    const sameWorst = worst(samePerson);
    const strangerBest = best(strangers);

    console.log(
      [
        `identity calibration — fixtures/faces/face-prints.json at ${MEASURED_AT_PX} px`,
        `  same-person pairs   ${samePerson.length}, worst ${sameWorst.toFixed(4)}`,
        `  stranger pairs      ${strangers.length}, best  ${strangerBest.toFixed(4)}`,
        `  clean band          ${(sameWorst - strangerBest).toFixed(4)} wide, around a threshold of ${MATCH_THRESHOLD}`,
      ].join("\n")
    );

    // ADR-0003 Decision 3, re-measured 6 Sep 2026 and reproduced here.
    expect(samePerson).toHaveLength(3);
    expect(strangers).toHaveLength(33);
    expect(sameWorst).toBeCloseTo(0.7263, 4);
    expect(strangerBest).toBeCloseTo(0.2979, 4);

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
 * The Not-a-Face calibration, recomputed in the gate.
 *
 * ADR-0003's amendment measured `NOT_A_FACE_THRESHOLD` over the kart fixtures,
 * whose ground truth is a human's classification of every detection
 * (`fixtures/karts/expected.json`). This half of the file recomputes that
 * table, asserts the exact set of detections 0.60 refuses, and fails the run on
 * a non-face it accepts.
 *
 * The band here is negative: 0.60 refuses every non-face with 0.0365 to spare
 * and refuses one real face by 0.0177 as the price. Asserting the exact set and
 * not "there is none" is what makes refusing a *different* face a failure.
 */
describe("the Not-a-Face calibration on the committed kart prints", () => {
  const reference = NOT_A_FACE_PRINTS;
  const dot = (a: readonly number[], b: readonly number[]): number =>
    a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

  /** Every classified detection with a print, against the reference set. */
  const measured = kartPrints()
    .filter((one) => !one.reference)
    .map((one) => ({
      id: one.id,
      is: one.is,
      pixels: one.pixels,
      nearest: reference.reduce(
        (high, print) => Math.max(high, dot(one.vector, print.vector)),
        Number.NEGATIVE_INFINITY
      ),
    }))
    .sort((a, b) => b.nearest - a.nearest);

  it("commits exactly the prints the fixtures mark as the reference set", () => {
    const marked = kartPrints().filter((one) => one.reference);
    expect(reference.map((one) => one.id)).toEqual(marked.map((one) => one.id));
    for (const [index, print] of reference.entries()) {
      // Byte-equal, not merely close: the committed file is a copy of the
      // fixture print, and the re-calibration ticket regenerates both together.
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
        `not-a-face calibration — fixtures/karts/face-prints.json, ${reference.length} reference print(s)`,
        `  classified detections  ${measured.length} (${faces.length} faces, ${nonFaces.length} non-faces), every one over the ${MIN_FACE_PX} px floor`,
        `  nearest non-face       ${furthestNonFace.nearest.toFixed(4)} — ${furthestNonFace.id}, ${furthestNonFace.pixels} px`,
        `  nearest real face      ${nearestFace.nearest.toFixed(4)} — ${nearestFace.id}, ${nearestFace.pixels} px`,
        `  held out of the set    ${heldOut.nearest.toFixed(4)} — ${heldOut.id}, ${heldOut.pixels} px`,
        `  threshold              ${NOT_A_FACE_THRESHOLD}`,
        `  clearance below the nearest non-face  ${(furthestNonFace.nearest - NOT_A_FACE_THRESHOLD).toFixed(4)}`,
        `  band                   ${(furthestNonFace.nearest - nearestFace.nearest).toFixed(4)} — there is none`,
      ].join("\n")
    );

    // ADR-0003's amendment, corrected 5 Sep 2026 at the 1600 px bound.
    expect(furthestNonFace.id).toBe("paddock-mixed.jpg#7");
    expect(furthestNonFace.nearest).toBeCloseTo(0.6365, 4);
    expect(nearestFace.id).toBe("paddock-mixed.jpg#8");
    expect(nearestFace.nearest).toBeCloseTo(0.6542, 4);
    // Both rejections are out of sample. The held-out second helmet is the
    // one that says the rule generalises past its own reference photograph.
    expect(heldOut.nearest).toBeCloseTo(0.6935, 4);
    expect(furthestNonFace.nearest - NOT_A_FACE_THRESHOLD).toBeCloseTo(
      0.0365,
      4
    );
    // The real face is nearer the reference than that non-face is: no value of
    // the threshold accepts it and still refuses the non-face. The band is
    // negative, and 0.60 is safe rather than centred.
    expect(furthestNonFace.nearest - nearestFace.nearest).toBeCloseTo(
      -0.0177,
      4
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
