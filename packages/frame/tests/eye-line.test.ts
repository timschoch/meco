import { describe, expect, it } from "vitest";
import { Annotation, type Box, type Size } from "@meco/contracts";
import { PHI_LINES, frameCrop, type FallbackRung } from "../index";
import {
  FACE_FIXTURES,
  KART_FIXTURES,
  TARGETS,
  eyeLineOfSample,
  oneFaceAnnotation,
  requestFor,
  vehicleAnnotation,
} from "./samples";

/** How far off a Golden Line the eyes may land. The ticket's tolerance. */
const TOLERANCE = 0.02;

const FACE_ONLY = { pinTo: ["face"] };
const KART_ONLY = { pinTo: ["kart"] };

/**
 * The cover window for each fixture at each target, in Source Image pixels.
 *
 * Written out rather than derived. It is the yardstick the Eye Line's zoom is
 * measured against, and a cover window that computed itself wrong here would
 * move the yardstick with the answer and hide the mistake.
 */
const COVER: Record<string, Size> = {
  // astronaut-portrait.jpg and artemis-2-crew.jpg are both 1280x1600.
  "astronaut-portrait.jpg 1:1": { width: 1280, height: 1280 },
  "astronaut-portrait.jpg 4:5": { width: 1280, height: 1600 },
  "astronaut-portrait.jpg 9:16": { width: 900, height: 1600 },
  "astronaut-portrait.jpg 16:9": { width: 1280, height: 720 },
  "artemis-2-crew.jpg 1:1": { width: 1280, height: 1280 },
  "artemis-2-crew.jpg 4:5": { width: 1280, height: 1600 },
  "artemis-2-crew.jpg 9:16": { width: 900, height: 1600 },
  "artemis-2-crew.jpg 16:9": { width: 1280, height: 720 },
  // soyuz-crew.jpg is 1600x777, wide enough that every target fills its height.
  "soyuz-crew.jpg 1:1": { width: 777, height: 777 },
  "soyuz-crew.jpg 4:5": { width: 622, height: 777 },
  "soyuz-crew.jpg 9:16": { width: 437, height: 777 },
  "soyuz-crew.jpg 16:9": { width: 1381, height: 777 },
};

/** Every fixture at every target, which is what the checks below sweep. */
const CASES = FACE_FIXTURES.flatMap((fixture) =>
  TARGETS.map(({ name: target, target: size }) => ({
    name: `${fixture.name} at ${target}`,
    fixture,
    target: size,
    cover: COVER[`${fixture.name} ${target}`] as Size,
  }))
);

/** One framing of one face fixture, reduced to the numbers the checks read. */
const measure = (
  raw: unknown,
  leadRegionId: string,
  target: Size,
  extra: Record<string, unknown> = FACE_ONLY
) => {
  const annotation = Annotation.parse(raw);
  const lead = annotation.regions.find((r) => r.id === leadRegionId)!;
  const eyes = (lead.landmarks!.rEye.y + lead.landmarks!.lEye.y) / 2;
  const { window, fallback } = frameCrop({
    annotation,
    request: requestFor(target, extra),
  });

  return {
    window,
    fallback,
    lead: lead.box,
    source: { width: annotation.width, height: annotation.height },
    slack: annotation.height - window.height,
    /** Where the eye midpoint sits in the frame the window cuts. */
    inFrame: (eyes * annotation.height - window.y) / window.height,
  };
};

/**
 * What the fallback ladder answered at each of the twelve, written out rather
 * than detected: a solver that fell back everywhere would otherwise pass the
 * sweep below by never being asked the Eye Line's question.
 *
 * Two shapes move the window. Both are 16:9 over a crew, where the cover window
 * is wide enough to hold every face and holding the crew is worth more than one
 * person's headroom.
 *
 * `soyuz-crew.jpg` sacrifices instead: at the three tall shapes no window of
 * that shape holds all three faces, and the leader alone is held by the very
 * window the Eye Line composed — so that is the window the drop rung buys back,
 * and the placement below is still the Eye Line's.
 */
const RUNG: Record<string, FallbackRung | "none"> = {
  "astronaut-portrait.jpg at 1:1": "none",
  "astronaut-portrait.jpg at 4:5": "none",
  "astronaut-portrait.jpg at 9:16": "none",
  "astronaut-portrait.jpg at 16:9": "none",
  "artemis-2-crew.jpg at 1:1": "none",
  "artemis-2-crew.jpg at 4:5": "none",
  "artemis-2-crew.jpg at 9:16": "none",
  "artemis-2-crew.jpg at 16:9": "relax",
  "soyuz-crew.jpg at 1:1": "drop",
  "soyuz-crew.jpg at 4:5": "drop",
  "soyuz-crew.jpg at 9:16": "drop",
  "soyuz-crew.jpg at 16:9": "zoom-out",
};

/** The rungs that leave the window where the Eye Line put it. */
const KEEPS_THE_WINDOW = new Set(["none", "drop"]);

/**
 * The rule itself. Every vertical the Eye Line keeps has slack, and every one
 * of them has it because the zoom made it: a cover window touches the Source
 * Image on one axis, and at three of these four shapes that axis is the
 * vertical. The `slack` check is what stops a solver that stopped sliding from
 * passing the placement check by never having anywhere to slide.
 */
describe("the eyes on the upper Golden Line", () => {
  // Without this, a fixture renamed or a shape added would read `undefined` out
  // of the table and take the Eye Line's branch by accident.
  it("names a rung for every one of the twelve", () => {
    expect(Object.keys(RUNG).sort()).toEqual(CASES.map((c) => c.name).sort());
  });

  for (const { name, fixture, target } of CASES) {
    const rung = RUNG[name] as FallbackRung | "none";

    it(`answers on the ${rung === "none" ? "composition itself" : `${rung} rung`}: ${name}`, () => {
      const { fallback } = measure(fixture.raw, fixture.leadRegionId, target);

      expect(fallback ?? "none").toBe(rung);
    });

    if (!KEEPS_THE_WINDOW.has(rung)) continue;

    it(`lands the eye midpoint at ${PHI_LINES[0].toFixed(3)}: ${name}`, () => {
      const { slack, inFrame } = measure(
        fixture.raw,
        fixture.leadRegionId,
        target
      );

      expect(slack).toBeGreaterThan(0);
      expect(Math.abs(inFrame - PHI_LINES[0])).toBeLessThanOrEqual(TOLERANCE);
    });
  }
});

/**
 * The two bounds on the zoom, swept over every fixture and target rather than
 * argued for on one. A convention about where a head looks best is not a
 * licence to widen a Crop, and headroom that left no window to hold the face is
 * the opposite of the point.
 *
 * The lower bound is on the size and not on containment. Whether the leading
 * face then lands inside the window is the fallback ladder's question, asked
 * after — `docs/specs/frame.md`, "The fallback ladder", built on #108.
 */
describe("what the zoom may not do", () => {
  for (const { name, fixture, target, cover } of CASES) {
    it(`never widens past the cover window: ${name}`, () => {
      const { window } = measure(fixture.raw, fixture.leadRegionId, target);

      expect(window.width).toBeLessThanOrEqual(cover.width);
      expect(window.height).toBeLessThanOrEqual(cover.height);
    });

    it(`never tightens below the size of the leading face: ${name}`, () => {
      const { window, lead, source } = measure(
        fixture.raw,
        fixture.leadRegionId,
        target
      );

      expect(window.width).toBeGreaterThanOrEqual(lead.width * source.width);
      expect(window.height).toBeGreaterThanOrEqual(lead.height * source.height);
    });

    it(`keeps the target shape within a pixel: ${name}`, () => {
      const { window } = measure(fixture.raw, fixture.leadRegionId, target);
      const aspect = target.width / target.height;

      expect(
        Math.abs(window.width - window.height * aspect)
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(window.height - window.width / aspect)
      ).toBeLessThanOrEqual(1);
    });
  }

  // The bound is not theoretical: this is the one fixture and target where the
  // Source Image already gives the eyes all the headroom they ask for, so the
  // rule has nothing to buy and takes the cover window unchanged.
  it("takes the cover window whole when there is room already", () => {
    const astronaut = FACE_FIXTURES[0]!;
    const { window } = measure(astronaut.raw, astronaut.leadRegionId, {
      width: 1920,
      height: 1080,
    });

    expect({ width: window.width, height: window.height }).toEqual(
      COVER["astronaut-portrait.jpg 16:9"]
    );
  });

  // A face taller than the cover window at this shape. The eyes ask for a zoom
  // of 0.70 — a window half again as tall as the Source Image holds — and the
  // answer is the cover window, not a wider one.
  it("never widens the window, however much headroom the eyes ask for", () => {
    const source = { width: 1000, height: 1000 };
    const face: Box = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    const { window } = frameCrop({
      annotation: oneFaceAnnotation(source, face),
      request: requestFor({ width: 1920, height: 1080 }, FACE_ONLY),
    });

    expect({ width: window.width, height: window.height }).toEqual({
      width: 1000,
      height: 563,
    });
  });

  // A face wide enough that the headroom the eyes ask for would leave a window
  // half its width. 9:16 over a square source ties the axes together: the floor
  // is the width the face needs, 500 px, and the height that shape then forces,
  // 889 px, against the 471 px the eyes alone would have asked for.
  //
  // A window the width floor sized is exactly as wide as the face, so it holds
  // the face only where it is aligned to the pixel — and the Golden Line puts
  // it 59 px out. The ladder answers, and `relax` is where it stops. So the
  // floor is no longer readable off the window here, and what this case holds
  // is that it ran at all: the window it sized was refused for its placement,
  // not for its size, and the sweep above keeps the floor honest at every
  // fixture and shape.
  it("sizes the window for a wide face, and the ladder rescues the placement", () => {
    const source = { width: 1000, height: 1000 };
    const face: Box = { x: 0.25, y: 0.1, width: 0.5, height: 0.2 };
    const framing = frameCrop({
      annotation: oneFaceAnnotation(source, face),
      request: requestFor({ width: 1080, height: 1920 }, FACE_ONLY),
    });

    expect(framing.fallback).toBe("relax");
    expect(framing.window.width).toBe(563);
    expect(framing.window.height).toBe(1000);
    // The face, 250 to 750, inside the window the ladder settled on.
    expect(framing.window.x).toBeLessThanOrEqual(250);
    expect(framing.window.x + framing.window.width).toBeGreaterThanOrEqual(750);
  });
});

/**
 * The amendment's own numbers, reproduced. `soyuz-crew.jpg` is the group that
 * made the case: ADR-0001, amendment of 5 Sep 2026, says why a floor taken over
 * the union of every face switches the rule off there.
 *
 * The suite asserts the leading-face figure, 38.2 % at a zoom of 1.12. The
 * union figure, 34.2 % at a zoom of 1, is what #103's named mutation puts back.
 */
describe("the headroom zoom, floored on the leading face", () => {
  const soyuz = FACE_FIXTURES[2]!;

  for (const target of ["1:1", "4:5", "9:16"] as const) {
    const shape = TARGETS.find((t) => t.name === target)!;
    const cover = COVER[`soyuz-crew.jpg ${target}`] as Size;

    it(`tightens the window and reaches the line: soyuz-crew.jpg at ${target}`, () => {
      const { window, inFrame } = measure(
        soyuz.raw,
        soyuz.leadRegionId,
        shape.target
      );

      // A union floor leaves this equal to the cover window, and the eyes at
      // 34.2 % with nowhere to slide.
      expect(window.height).toBeLessThan(cover.height);
      expect(cover.height / window.height).toBeCloseTo(1.12, 2);
      expect(Math.abs(inFrame - PHI_LINES[0])).toBeLessThanOrEqual(TOLERANCE);
    });
  }
});

/**
 * The Eye Line is the midpoint of the two eyes, and on a head held straight
 * every recording makes that indistinguishable from either eye alone — the
 * three fixtures put the two within 0.002 of the Source Image height. A tilted
 * head is what tells them apart.
 */
describe("a head held at an angle", () => {
  it("reads the midpoint of the two eyes, not one of them", () => {
    const source = { width: 1000, height: 1000 };
    const face: Box = { x: 0.4, y: 0.3, width: 0.2, height: 0.2 };
    // 0.32 and 0.44 average to 0.38; the right eye alone would say 0.32, which
    // buys a third more headroom and puts the midpoint at 45 % of the frame.
    const annotation = oneFaceAnnotation(source, face, {
      rEye: { x: 0.46, y: 0.32 },
      lEye: { x: 0.54, y: 0.44 },
      nose: { x: 0.5, y: 0.4 },
      rMouth: { x: 0.45, y: 0.45 },
      lMouth: { x: 0.53, y: 0.48 },
    });
    const { window } = frameCrop({
      annotation,
      request: requestFor({ width: 1080, height: 1080 }, FACE_ONLY),
    });

    const inFrame = (0.38 * source.height - window.y) / window.height;

    expect(source.height - window.height).toBeGreaterThan(0);
    expect(Math.abs(inFrame - PHI_LINES[0])).toBeLessThanOrEqual(TOLERANCE);
  });
});

/**
 * A declared `subjectArea` turns the Eye Line off entirely: that is somebody
 * saying where the Subject goes, about the whole Subject Box rather than about
 * the eyes.
 *
 * What a Subject Area does with the window instead is #106's. What this holds,
 * whatever #106 ships, is that it is not the Eye Line doing it.
 */
describe("a declared subjectArea", () => {
  const soyuz = FACE_FIXTURES[2]!;
  const SQUARE = { width: 1080, height: 1080 };
  const AREA: Box = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };

  it("turns the Eye Line off", () => {
    const off = measure(soyuz.raw, soyuz.leadRegionId, SQUARE, {
      ...FACE_ONLY,
      subjectArea: AREA,
    });
    const on = measure(soyuz.raw, soyuz.leadRegionId, SQUARE);

    expect(off.window).not.toEqual(on.window);
    expect(Math.abs(off.inFrame - PHI_LINES[0])).toBeGreaterThan(TOLERANCE);
  });

  // The area sizes it, and its answer is nothing like the Eye Line's. The face
  // is 0.089332 x 0.262317 of a 1600x777 picture — 142.9 x 203.8 px — and
  // filling 0.6 of a square frame with the taller axis asks for 203.8 / 0.6 =
  // 340. The Eye Line would have asked for 695.
  it("hands the sizing to the Subject Area", () => {
    const { window } = measure(soyuz.raw, soyuz.leadRegionId, SQUARE, {
      ...FACE_ONLY,
      subjectArea: AREA,
    });

    expect({ width: window.width, height: window.height }).toEqual({
      width: 340,
      height: 340,
    });
  });
});

/**
 * A Region without landmarks contributes no Eye Line. contracts requires a
 * `face` to carry them and no other Kind does, so this is what keeps the rule
 * off the kart rung without the kart rung knowing the rule exists.
 */
describe("a Subject with no eyes to read", () => {
  it("leaves a lone vehicle at the cover window", () => {
    const source = { width: 1200, height: 800 };
    const { window } = frameCrop({
      annotation: vehicleAnnotation(source),
      request: requestFor({ width: 1080, height: 1080 }, KART_ONLY),
    });

    expect({ width: window.width, height: window.height }).toEqual({
      width: 800,
      height: 800,
    });
  });

  for (const fixture of KART_FIXTURES) {
    it(`leaves the kart Subject at the cover window: ${fixture.name}`, () => {
      const annotation = Annotation.parse(fixture.raw);
      const { window } = frameCrop({
        annotation,
        request: requestFor({ width: 1080, height: 1350 }, KART_ONLY),
      });

      // A cover window fills one axis of the Source Image; a tightened one
      // fills neither.
      expect(
        window.width === annotation.width || window.height === annotation.height
      ).toBe(true);
    });
  }
});

/**
 * The synthetic geometry no recording happens to contain: eyes far enough down
 * the frame that the Source Image already holds all the headroom the rule
 * asks for.
 */
describe("a face the Source Image already frames", () => {
  it("is left at the cover window", () => {
    const source = { width: 1000, height: 1000 };
    const face: Box = { x: 0.4, y: 0.3, width: 0.2, height: 0.2 };

    expect(eyeLineOfSample(face)).toBe(0.38);

    const { window } = frameCrop({
      annotation: oneFaceAnnotation(source, face),
      request: requestFor({ width: 1920, height: 1080 }, FACE_ONLY),
    });

    expect({ width: window.width, height: window.height }).toEqual({
      width: 1000,
      height: 563,
    });
  });
});
