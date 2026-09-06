/**
 * The `match` rung when the Match was made by a race number rather than a
 * face, on the Annotation of `fixtures/karts/kart-grid-24.jpg` recorded
 * through the shipped Catalogue.
 *
 * This photograph is the reason the feature exists. Five karts on a grid, the
 * subject is the #24 in the middle, and its driver is in a helmet. The `kart`
 * rung seeds on the largest `vehicle` box, which here is a row-wide detection
 * covering 0.5527 of the frame against the #24 kart's 0.1275 — so `kart` frames
 * the grid and not the kart, and every check below would pass by accident if
 * the rung fell back to it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Annotation } from "@meco/contracts";
import { describe, expect, it } from "vitest";
import { frameCrop } from "../index";
import { matchOf, numberMatchOf, requestFor } from "./samples";

const ANNOTATIONS = fileURLToPath(
  new URL("../../../fixtures/karts/annotations/", import.meta.url)
);

/**
 * The shared recording, parsed by the contracts schema like every fixture
 * here. Shared with identify's suite, which tests the rule that produced the
 * Matches below on this same file.
 */
const grid = (): Annotation =>
  Annotation.parse(
    JSON.parse(readFileSync(`${ANNOTATIONS}kart-grid-24.json`, "utf8"))
  );

const STORY_TARGET = { width: 1080, height: 1920 };
const MATCH_ONLY = { pinTo: ["match"] };

/** The kart carrying the `24`, as identify's number rule names it. */
const KART_24 = "vehicle-3";
/** The largest `vehicle` box in the photograph, which is not a single kart. */
const BIGGEST = "vehicle-5";
/** The `number` Region the `24` was read from. */
const NUMBER_24 = "number-2";

const boxOf = (regionId: string) =>
  grid().regions.find((region) => region.id === regionId)!.box;

const area = (box: { width: number; height: number }) =>
  box.width * box.height;

describe("the match rung on a number Match", () => {
  it("leads on the kart the number is painted on, not on the biggest kart", () => {
    const framing = frameCrop({
      annotation: grid(),
      matches: [numberMatchOf(KART_24, "person-24", NUMBER_24)],
      request: requestFor(STORY_TARGET, MATCH_ONLY),
    });

    expect(framing.resolvedBy).toBe("match");
    expect(framing.leadRegionId).toBe(KART_24);
    expect(framing.leadRegionId).not.toBe(BIGGEST);
    // And the arithmetic behind the claim, so the check says why it matters.
    expect(area(boxOf(BIGGEST))).toBeGreaterThan(area(boxOf(KART_24)));
  });

  it("composes the kart and its driver, not the number plate", () => {
    const framing = frameCrop({
      annotation: grid(),
      matches: [numberMatchOf(KART_24, "person-24", NUMBER_24)],
      request: requestFor(STORY_TARGET, MATCH_ONLY),
    });

    // The `kart` rung's union, seeded on the named kart: the Subject holds the
    // vehicle box whole and is bigger than it, because the driver joined.
    const kart = boxOf(KART_24);
    const subject = framing.subject!;
    expect(subject.x).toBeLessThanOrEqual(kart.x);
    expect(subject.y).toBeLessThanOrEqual(kart.y);
    expect(subject.x + subject.width).toBeGreaterThanOrEqual(
      kart.x + kart.width
    );
    expect(subject.y + subject.height).toBeGreaterThanOrEqual(
      kart.y + kart.height
    );
    // Never the digits: the `24` is 0.0584 by 0.0909 of the frame and a
    // Subject that size would be a Crop of a number plate.
    expect(area(subject)).toBeGreaterThan(area(boxOf(NUMBER_24)) * 10);
    expect(framing.keptRegionIds).toContain(KART_24);
  });

  it("takes no kart the picture does not hold, and falls through", () => {
    const framing = frameCrop({
      annotation: grid(),
      // A Match naming a Region of another photograph. There is no box to
      // frame, so the rung composes nothing and the ladder walks past it.
      matches: [numberMatchOf("vehicle-99", "person-24", NUMBER_24)],
      request: requestFor(STORY_TARGET, MATCH_ONLY),
    });

    expect(framing.resolvedBy).toBe("center");
    expect(framing.leadRegionId).toBeUndefined();
  });

  it("leads on the face when the same Person is matched both ways", () => {
    const framing = frameCrop({
      annotation: grid(),
      matches: [
        numberMatchOf(KART_24, "person-24", NUMBER_24),
        matchOf("face-1", "person-24", 0.62),
      ],
      request: requestFor(STORY_TARGET, MATCH_ONLY),
    });

    // The face is the tighter Subject and the Eye Line is calibrated on face
    // boxes. The number Match answers where the face rule cannot.
    expect(framing.leadRegionId).toBe("face-1");
    expect(framing.subject).toEqual(boxOf("face-1"));
  });

  it("lets persons narrow who may lead on a number, like any other Match", () => {
    const request = requestFor(STORY_TARGET, {
      ...MATCH_ONLY,
      persons: ["someone-else"],
    });

    const framing = frameCrop({
      annotation: grid(),
      matches: [numberMatchOf(KART_24, "person-24", NUMBER_24)],
      request,
    });

    expect(framing.resolvedBy).toBe("center");
  });

  it("takes the lowest Region id when two karts carry the same number", () => {
    // The same Person read on two karts, which identify reports rather than
    // choosing between. Both orders, because a tie settled by the input order
    // would pass one of them and fail the other.
    const matches = [
      numberMatchOf("vehicle-8", "person-24", "number-4"),
      numberMatchOf(KART_24, "person-24", NUMBER_24),
    ];

    for (const ordered of [matches, [...matches].reverse()]) {
      const framing = frameCrop({
        annotation: grid(),
        matches: ordered,
        request: requestFor(STORY_TARGET, MATCH_ONLY),
      });
      expect(framing.leadRegionId).toBe(KART_24);
    }
  });
});
