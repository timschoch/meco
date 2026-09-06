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
import { MATCH_MARGIN, MATCH_THRESHOLD } from "../index";
import { printPairs } from "./fixtures";

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
