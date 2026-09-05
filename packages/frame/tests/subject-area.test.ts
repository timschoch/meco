import { describe, expect, it } from "vitest";
import { FramingRequest } from "@meco/contracts";
import { PHI_LINES, frameCrop } from "../index";
import {
  SOURCES,
  TARGETS,
  emptyAnnotation,
  oneFaceAnnotation,
  requestFor,
} from "./samples";

const SQUARE_TARGET = { width: 1080, height: 1080 };

/** `face` alone, so nothing else can answer and hide what the area did. */
const FACE_ONLY = { pinTo: ["face"] };

/**
 * A framing of one face at a chosen box, with a Subject Area declared. Every
 * case below is arithmetic on numbers written out in its own comment, so a
 * mutation of the area rule cannot mutate the expectation with it.
 */
const framingWith = (
  source: { width: number; height: number },
  face: { x: number; y: number; width: number; height: number },
  subjectArea: { x: number; y: number; width: number; height: number },
  target = SQUARE_TARGET
) =>
  frameCrop({
    annotation: oneFaceAnnotation(source, face),
    request: requestFor(target, { ...FACE_ONLY, subjectArea }),
  });

// A Subject Area is a statement about proportions: a Subject `sw` wide filling
// a fraction `area.width` of the frame fixes the frame at `sw / area.width`.
// Both axes propose a window and the larger wins, since the other then has room
// to spare. The pair below is the same numbers mirrored, so a solver that read
// one axis, or took the smaller of the two, is red on one case or the other.
//
// 2000x2000 at 1:1 cuts a 2000x2000 cover window, so both axes have slack and
// nothing but the area decides the size.
describe("the Subject Area sizes the window", () => {
  const SOURCE = { width: 2000, height: 2000 };
  const AREA = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };

  // 200 px wide, 400 px tall. Across: 200 / 0.4 = 500. Down: 400 / 0.4 = 1000.
  it("takes the window the taller axis asks for, when down asks for more", () => {
    const { window } = framingWith(
      SOURCE,
      { x: 0.4, y: 0.3, width: 0.1, height: 0.2 },
      AREA
    );

    expect(window).toEqual({ x: 400, y: 300, width: 1000, height: 1000 });
  });

  // 400 px wide, 200 px tall. Across: 400 / 0.4 = 1000. Down: 200 / 0.4 = 500.
  it("takes the window the wider axis asks for, when across asks for more", () => {
    const { window } = framingWith(
      SOURCE,
      { x: 0.3, y: 0.4, width: 0.2, height: 0.1 },
      AREA
    );

    expect(window).toEqual({ x: 300, y: 400, width: 1000, height: 1000 });
  });
});

// 3000x2000 at 1:1 cuts a 2000x2000 cover window, and the area tightens it to
// 600x600, so both axes have slack and the aim is free on both.
//
// The face is at the middle of the picture and the area is not, so the centre
// of the area, the centre of the frame and both Golden Lines are four different
// answers and only one of them passes.
describe("the Subject aims at the centre of the Subject Area", () => {
  const SOURCE = { width: 3000, height: 2000 };
  const FACE = { x: 0.5, y: 0.5, width: 0.1, height: 0.1 };
  const AREA = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };

  // 300 px wide, 200 px tall. Across: 300 / 0.5 = 600. Down: 200 / 0.5 = 400.
  // The Subject's centre sits at 1650, 1100 and the area's at 0.35, 0.45, so
  // the window starts at 1650 - 0.35 * 600 and 1100 - 0.45 * 600.
  it("puts the Subject's centre where the area's centre is", () => {
    const { window } = framingWith(SOURCE, FACE, AREA);

    expect(window).toEqual({ x: 1440, y: 830, width: 600, height: 600 });
  });

  it("does not put it on a Golden Line", () => {
    const { window } = framingWith(SOURCE, FACE, AREA);
    const inFrame = (1650 - window.x) / window.width;

    expect(inFrame).toBeCloseTo(0.35, 10);
    for (const line of PHI_LINES) {
      expect(Math.abs(inFrame - line)).toBeGreaterThan(0.02);
    }
  });

  // Read off the window rather than trusting the numbers above: the area maps
  // onto the window at 1500..1800 across and 950..1250 down, and the Subject
  // fills the first exactly and sits inside the second.
  it("says the area was satisfied, and nothing fell short", () => {
    const framing = framingWith(SOURCE, FACE, AREA);

    expect(framing.subjectAreaSatisfied).toBe(true);
    expect(framing.subjectAreaShortfall).toBe(1);
  });
});

// The prototype threw here (ADR-0001). frame answers every geometry it is
// given: the cover window is the best there is, and the shortfall says by how
// much the Source Image fell short.
//
// 1000x1000 at 1:1 covers the whole picture. A 600 px face filling half the
// frame needs a 1200 px window, and 1200 is 1.2 times the 1000 there is.
describe("a Source Image too small to fill the Subject Area", () => {
  const SOURCE = { width: 1000, height: 1000 };
  const FACE = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
  const AREA = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };

  it("returns a window and does not throw", () => {
    expect(() => framingWith(SOURCE, FACE, AREA)).not.toThrow();
    expect(framingWith(SOURCE, FACE, AREA).window).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 1000,
    });
  });

  it("says the area was missed, and by what factor", () => {
    const framing = framingWith(SOURCE, FACE, AREA);

    expect(framing.subjectAreaSatisfied).toBe(false);
    expect(framing.subjectAreaShortfall).toBeCloseTo(1.2, 10);
  });

  // Above 1 and not below it. A ratio written the other way up is still a
  // number, still monotonic in the miss, and still wrong.
  it("reports the shortfall above 1, the factor the source is short by", () => {
    const framing = framingWith(SOURCE, FACE, AREA);

    expect(framing.subjectAreaShortfall).toBeGreaterThan(1);
  });

  it("still reports the rung that composed the Subject", () => {
    const framing = framingWith(SOURCE, FACE, AREA);

    expect(framing.resolvedBy).toBe("face");
    expect(framing.leadRegionId).toBe("face-1");
  });
});

// The case the flag exists to report: a Source Image big enough for the area,
// on a window that could not be slid far enough to land the Subject in it.
// Satisfaction is containment on the window actually cut; the shortfall is a
// ratio of sizes. They disagree exactly when the miss was not about size.
//
// 3000x2000 at 1:1, a 300 px face filling 0.3 of the frame, so a 1000 px
// window the 2000 px cover window has room for. The face sits 210 px from the
// left and the area's centre is at 0.75, which asks the window to start at
// -540: it starts at 0 instead, and the Subject lands at 0.06 of a frame whose
// area spans 0.6 to 0.9.
describe("a window clamped by the Source Image before it reached the area", () => {
  const framing = () =>
    framingWith(
      { width: 3000, height: 2000 },
      { x: 0.02, y: 0.45, width: 0.1, height: 0.1 },
      { x: 0.6, y: 0.35, width: 0.3, height: 0.3 }
    );

  it("cuts the window the area sized, against the edge of the picture", () => {
    expect(framing().window).toEqual({
      x: 0,
      y: 500,
      width: 1000,
      height: 1000,
    });
  });

  it("says the area was missed, on the window actually cut", () => {
    expect(framing().subjectAreaSatisfied).toBe(false);
  });

  it("reports no shortfall, because the Source Image was big enough", () => {
    expect(framing().subjectAreaShortfall).toBe(1);
  });
});

// A Subject Area does two jobs and needs a Subject for both: it sizes the
// window so the Subject fills it, and it aims that Subject. The anchor and the
// centre compose no Subject at all (#82, shipped in #136), so an area has
// nothing to work on and the window is placed as it would have been.
describe("a Subject Area with nothing composed to put in it", () => {
  const framing = () =>
    frameCrop({
      annotation: emptyAnnotation({ width: 1200, height: 800 }),
      request: requestFor(SQUARE_TARGET, {
        subjectArea: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      }),
    });

  it("leaves the window where the centre put it", () => {
    expect(framing().window).toEqual({ x: 200, y: 0, width: 800, height: 800 });
    expect(framing().resolvedBy).toBe("center");
  });

  it("says the area was not satisfied, no Subject having filled it", () => {
    expect(framing().subjectAreaSatisfied).toBe(false);
    expect(framing().subjectAreaShortfall).toBe(1);
  });
});

// The other half of the pair `anchor.test.ts` already checks: nothing is
// claimed about an area nobody named, and both fields appear the moment one is.
describe("the two fields the Subject Area reports", () => {
  it("are both present when the request named an area", () => {
    const framing = framingWith(
      { width: 2000, height: 2000 },
      { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      { x: 0.3, y: 0.3, width: 0.4, height: 0.4 }
    );

    expect(framing.subjectAreaSatisfied).toBeDefined();
    expect(framing.subjectAreaShortfall).toBeDefined();
  });

  it("are both absent when it did not", () => {
    const framing = frameCrop({
      annotation: oneFaceAnnotation(
        { width: 2000, height: 2000 },
        { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }
      ),
      request: requestFor(SQUARE_TARGET, FACE_ONLY),
    });

    expect(framing.subjectAreaSatisfied).toBeUndefined();
    expect(framing.subjectAreaShortfall).toBeUndefined();
  });
});

// The contracts `Box` already says a Subject Area is a positive rectangle
// inside the frame, so frame never checks it again. Asserted here because it is
// frame's suite that would go red if the schema stopped saying it.
describe("a Subject Area that is not a rectangle inside the frame", () => {
  const REFUSED: { name: string; subjectArea: Record<string, number> }[] = [
    {
      name: "no width",
      subjectArea: { x: 0.2, y: 0.2, width: 0, height: 0.5 },
    },
    {
      name: "no height",
      subjectArea: { x: 0.2, y: 0.2, width: 0.5, height: 0 },
    },
    {
      name: "off the right edge",
      subjectArea: { x: 0.6, y: 0.2, width: 0.5, height: 0.5 },
    },
    {
      name: "off the bottom edge",
      subjectArea: { x: 0.2, y: 0.6, width: 0.5, height: 0.5 },
    },
    {
      name: "starting outside the frame",
      subjectArea: { x: -0.1, y: 0.2, width: 0.5, height: 0.5 },
    },
  ];

  for (const { name, subjectArea } of REFUSED) {
    it(`is refused by the contracts schema: ${name}`, () => {
      expect(() => requestFor(SQUARE_TARGET, { subjectArea })).toThrow();
    });
  }

  it("is what FramingRequest promises, so frame is never handed one", () => {
    expect(FramingRequest.shape.subjectArea).toBeDefined();
  });
});

// The cover window rounds one axis, because it touches the Source Image on the
// other. A window the Subject Area sized touches neither, so both axes round
// and the promises `properties.test.ts` makes for the cover window have to be
// made again here.
describe("the window a Subject Area sized, whatever the shapes", () => {
  const FACE = { x: 0.35, y: 0.3, width: 0.2, height: 0.25 };
  const AREA = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };

  const CASES = SOURCES.flatMap((source) =>
    TARGETS.map(({ name, target }) => ({
      name: `${String(source.width)}x${String(source.height)} at ${name}`,
      source,
      target,
      frame: () => framingWith(source, FACE, AREA, target),
    }))
  );

  for (const { name, source, target, frame } of CASES) {
    it(`is whole pixels inside the Source Image: ${name}`, () => {
      const { x, y, width, height } = frame().window;

      for (const value of [x, y, width, height]) {
        expect(Number.isInteger(value)).toBe(true);
      }
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(source.width);
      expect(y + height).toBeLessThanOrEqual(source.height);
    });

    it(`is within one pixel of the target aspect, on both axes: ${name}`, () => {
      const { width, height } = frame().window;
      const aspect = target.width / target.height;

      expect(Math.abs(width - height * aspect)).toBeLessThanOrEqual(1);
      expect(Math.abs(height - width / aspect)).toBeLessThanOrEqual(1);
    });

    it(`is never larger than the cover window: ${name}`, () => {
      const { window } = frame();
      const cover = frameCrop({
        annotation: oneFaceAnnotation(source, FACE),
        request: requestFor(target, FACE_ONLY),
      }).window;

      expect(window.width).toBeLessThanOrEqual(cover.width);
      expect(window.height).toBeLessThanOrEqual(cover.height);
    });

    it(`answers the same twice: ${name}`, () => {
      expect(frame()).toEqual(frame());
    });
  }
});
