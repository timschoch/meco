import { describe, expect, it } from "vitest";
import { Annotation, type Box, type Size } from "@meco/contracts";
import { frameCrop } from "../index";
import {
  FACE_FIXTURES,
  KART_FIXTURES,
  PODIUM_FIXTURES,
  SOURCES,
  TARGETS,
  facesAnnotation,
  matchOf,
  requestFor,
} from "./samples";

const SQUARE = { width: 1080, height: 1080 };
const FACE_ONLY = { pinTo: ["face"] };
const KART_ONLY = { pinTo: ["kart"] };

/** Whether a box, in source fractions, lies inside a window. Whole pixels, no slack. */
const holds = (
  window: { x: number; y: number; width: number; height: number },
  box: Box,
  source: Size
): boolean =>
  box.x * source.width >= window.x &&
  box.y * source.height >= window.y &&
  (box.x + box.width) * source.width <= window.x + window.width &&
  (box.y + box.height) * source.height <= window.y + window.height;

describe("no rung ran", () => {
  it("says so, and names none", () => {
    const source = { width: 1000, height: 1000 };
    const framing = frameCrop({
      annotation: facesAnnotation(source, [
        { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      ]),
      request: requestFor(SQUARE, FACE_ONLY),
    });

    expect(framing.satisfied).toBe(true);
    expect(framing.fallback).toBeUndefined();
    expect(framing.droppedRegionIds).toEqual([]);
    expect(framing.keptRegionIds).toEqual(["face-1"]);
  });
});

describe("the zoom-out rung", () => {
  const source = { width: 1000, height: 1000 };
  const framing = () =>
    frameCrop({
      annotation: facesAnnotation(source, [
        { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
        { x: 0.05, y: 0.05, width: 0.1, height: 0.1 },
      ]),
      request: requestFor(SQUARE, {
        ...FACE_ONLY,
        subjectArea: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      }),
    });

  it("drops back to the cover window when the first one misses a face", () => {
    expect(framing().fallback).toBe("zoom-out");
    expect(framing().satisfied).toBe(false);
    expect(framing().window).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 1000,
    });
  });

  it("keeps every face, having sacrificed none", () => {
    expect(framing().keptRegionIds).toEqual(["face-1", "face-2"]);
    expect(framing().droppedRegionIds).toEqual([]);
  });
});

describe("the relax rung", () => {
  const source = { width: 1600, height: 800 };
  const faces: Box[] = [
    { x: 0.25, y: 0.3, width: 0.1, height: 0.2 },
    { x: 0.0625, y: 0.35, width: 0.04, height: 0.1 },
  ];
  const framing = () =>
    frameCrop({
      annotation: facesAnnotation(source, faces),
      request: requestFor(SQUARE, FACE_ONLY),
    });

  it("slides the aim to the middle when the cover window at the Golden Line misses", () => {
    expect(framing().fallback).toBe("relax");
    expect(framing().droppedRegionIds).toEqual([]);
  });

  it("holds every face there", () => {
    for (const box of faces) {
      expect(holds(framing().window, box, source)).toBe(true);
    }
  });
});

/**
 * The halfway step, which only a face on each side of the composition can ask
 * for. The cover window reaches x 174 to 974 at the Golden Line, 127 to 927
 * halfway to the middle, and 80 to 880 at the middle; the two faces beside the
 * leader sit at 132 to 172 and at 892 to 924, so halfway is the only one of the
 * three that holds them both.
 *
 * Without the step the ladder slides straight to the middle, loses the face on
 * the right and answers by sacrificing it.
 */
describe("the relax rung, halfway", () => {
  const source = { width: 1600, height: 800 };
  const faces: Box[] = [
    { x: 0.25, y: 0.3, width: 0.1, height: 0.2 },
    { x: 0.0825, y: 0.35, width: 0.025, height: 0.08 },
    { x: 0.5575, y: 0.35, width: 0.02, height: 0.08 },
  ];
  const framing = () =>
    frameCrop({
      annotation: facesAnnotation(source, faces),
      request: requestFor(SQUARE, FACE_ONLY),
    });

  it("stops halfway when the middle would lose a face", () => {
    expect(framing().fallback).toBe("relax");
    expect(framing().droppedRegionIds).toEqual([]);
    expect(framing().window.x).toBe(127);
  });

  it("holds every face there", () => {
    for (const box of faces) {
      expect(holds(framing().window, box, source)).toBe(true);
    }
  });
});

/**
 * Three faces no window of this shape can hold at once. The far one is the
 * cheapest, so it is the one sacrificed, and the two that remain are held.
 */
describe("the drop rung", () => {
  const source = { width: 1600, height: 800 };
  const LEAD: Box = { x: 0.475, y: 0.3, width: 0.05, height: 0.2 };
  const NEAR: Box = { x: 0.3, y: 0.35, width: 0.04, height: 0.1 };
  const FAR: Box = { x: 0.95, y: 0.35, width: 0.03, height: 0.08 };

  const framing = () =>
    frameCrop({
      annotation: facesAnnotation(source, [LEAD, NEAR, FAR]),
      request: requestFor(SQUARE, FACE_ONLY),
    });

  it("sacrifices the cheapest face and names the rung", () => {
    expect(framing().fallback).toBe("drop");
    expect(framing().satisfied).toBe(false);
    expect(framing().keptRegionIds).toEqual(["face-1", "face-2"]);
    expect(framing().droppedRegionIds).toEqual(["face-3"]);
  });

  it("holds every face it kept", () => {
    for (const box of [LEAD, NEAR]) {
      expect(holds(framing().window, box, source)).toBe(true);
    }
    expect(holds(framing().window, FAR, source)).toBe(false);
  });

  // The same geometry with the far face matched. It rises to the middle tier,
  // so the near face becomes the cheapest and is sacrificed first — and
  // sacrificing it repairs nothing, so the leader ends up alone.
  it("sacrifices by tier and not by distance", () => {
    const matched = frameCrop({
      annotation: facesAnnotation(source, [LEAD, NEAR, FAR]),
      matches: [
        matchOf("face-1", "person-a", 0.9),
        matchOf("face-3", "person-c", 0.5),
      ],
      request: requestFor(SQUARE, { pinTo: ["match"] }),
    });

    expect(matched.fallback).toBe("drop");
    expect(matched.keptRegionIds).toEqual(["face-1"]);
    expect(matched.droppedRegionIds).toEqual(["face-3", "face-2"]);
  });

  it("never sacrifices the Leading Subject", () => {
    expect(framing().keptRegionIds[0]).toBe(framing().leadRegionId);
    expect(framing().droppedRegionIds).not.toContain(framing().leadRegionId);
  });
});

describe("the clip rung", () => {
  const source = { width: 1000, height: 1000 };
  const target = { width: 1920, height: 1080 };
  const framing = () =>
    frameCrop({
      annotation: facesAnnotation(source, [
        { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      ]),
      request: requestFor(target, FACE_ONLY),
    });

  it("accepts the clipping when no window of that shape holds the Subject", () => {
    expect(framing().fallback).toBe("clip");
    expect(framing().satisfied).toBe(false);
  });

  it("sacrifices nobody: there was nobody left to sacrifice", () => {
    expect(framing().keptRegionIds).toEqual(["face-1"]);
    expect(framing().droppedRegionIds).toEqual([]);
  });

  it("still returns the cover window, in whole pixels, on the Source Image", () => {
    const { window } = framing();

    expect(window).toEqual({ x: 0, y: 219, width: 1000, height: 563 });
  });
});

/**
 * The window this construction cuts is x 305 to 815 — measured, and written out
 * so the check does not read it off the rule it is checking. A face whose edge
 * sits 0.4 px past that edge is inside; one 0.6 px past it is not.
 *
 * The window is rounded to whole pixels before it is cut, so exact containment
 * would report a fallback for a Subject half a pixel out. The half pixel is one
 * budget spent once, shared with the Subject Area's containment and the
 * Occlusion Zones' clearance.
 */
describe("the half pixel of containment slack", () => {
  const source = { width: 1000, height: 1000 };
  const TALL = { width: 1080, height: 1920 };
  const LEAD: Box = { x: 0.45, y: 0.4, width: 0.1, height: 0.1 };

  /** A second face whose right edge sits `out` pixels past the window's. */
  const framingWithEdgeAt = (out: number) =>
    frameCrop({
      annotation: facesAnnotation(source, [
        LEAD,
        { x: (815 + out) / 1000 - 0.05, y: 0.5, width: 0.05, height: 0.05 },
      ]),
      request: requestFor(TALL, FACE_ONLY),
    });

  it("cuts the window it was measured at", () => {
    const { window } = frameCrop({
      annotation: facesAnnotation(source, [LEAD]),
      request: requestFor(TALL, FACE_ONLY),
    });

    expect(window.x).toBe(305);
    expect(window.x + window.width).toBe(815);
  });

  it("holds a face 0.4 px outside the window", () => {
    const framing = framingWithEdgeAt(0.4);

    expect(framing.satisfied).toBe(true);
    expect(framing.fallback).toBeUndefined();
    expect(framing.droppedRegionIds).toEqual([]);
  });

  it("does not hold one 0.6 px outside it", () => {
    // The cover window is wider than this one, so `zoom-out` is what rescues
    // it. Which rung answers is not the point; that one had to is.
    expect(framingWithEdgeAt(0.6).fallback).toBe("zoom-out");
  });
});

describe("what a rung reports", () => {
  it("marks a sacrifice as a Subject Area miss, at no shortfall", () => {
    const source = { width: 1600, height: 800 };
    const framing = frameCrop({
      annotation: facesAnnotation(source, [
        { x: 0.2375, y: 0.3, width: 0.05, height: 0.2 },
        { x: 0.875, y: 0.375, width: 0.025, height: 0.075 },
      ]),
      request: requestFor(SQUARE, {
        ...FACE_ONLY,
        subjectArea: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      }),
    });

    expect(framing.fallback).toBe("drop");
    expect(framing.droppedRegionIds).toEqual(["face-2"]);
    expect(framing.subjectAreaSatisfied).toBe(false);
    expect(framing.subjectAreaShortfall).toBe(1);
  });
});

/**
 * Every fixture at every shape, and every constructed Annotation above: the
 * window is a window whatever rung answered.
 */
describe("the window, whichever rung ran", () => {
  const ANNOTATIONS = [
    ...FACE_FIXTURES,
    ...PODIUM_FIXTURES,
    ...KART_FIXTURES,
  ].map((f) => ({
    name: f.name,
    annotation: Annotation.parse(f.raw),
  }));

  for (const { name, annotation } of ANNOTATIONS) {
    for (const { name: shape, target } of TARGETS) {
      it(`is whole pixels, on the picture, of the target shape: ${name} at ${shape}`, () => {
        const { window, fallback, satisfied } = frameCrop({
          annotation,
          request: requestFor(target),
        });
        const aspect = target.width / target.height;

        for (const value of Object.values(window)) {
          expect(Number.isInteger(value)).toBe(true);
        }
        expect(window.x).toBeGreaterThanOrEqual(0);
        expect(window.y).toBeGreaterThanOrEqual(0);
        expect(window.x + window.width).toBeLessThanOrEqual(annotation.width);
        expect(window.y + window.height).toBeLessThanOrEqual(annotation.height);
        expect(
          Math.abs(window.width - window.height * aspect)
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(window.height - window.width / aspect)
        ).toBeLessThanOrEqual(1);
        expect(satisfied).toBe(fallback === undefined);
      });
    }
  }
});

/** Which rungs the nine recordings reach at the four shapes, on one ladder. */
const rungsReached = (extra: Record<string, unknown>): string[] =>
  [
    ...new Set(
      [...FACE_FIXTURES, ...PODIUM_FIXTURES, ...KART_FIXTURES].flatMap(
        (fixture) => {
          const annotation = Annotation.parse(fixture.raw);

          return TARGETS.map(
            ({ target }) =>
              frameCrop({ annotation, request: requestFor(target, extra) })
                .fallback ?? "none"
          );
        }
      )
    ),
  ].sort();

/**
 * Each ladder's own set, asserted whole rather than unioned. A union would
 * pass on one ladder reaching everything and the other reaching nothing.
 *
 * The default ladder reaches all five, which is what `kart` before `face`
 * bought: `clip` is only reached by a Subject no window of the target shape
 * can hold, and on these nine photographs that is the kart union. With `face`
 * first the kart rung never answered a recording carrying a face, and the
 * default ladder reached four.
 *
 * The kart rung alone reaches four of the five and not the same four: nothing
 * it composes needs `zoom-out`.
 */
describe("the recordings reach every rung", () => {
  it("reaches all five on the default ladder", () => {
    expect(rungsReached({})).toEqual([
      "clip",
      "drop",
      "none",
      "relax",
      "zoom-out",
    ]);
  });

  it("reaches four of them on the kart rung alone", () => {
    expect(rungsReached(KART_ONLY)).toEqual(["clip", "drop", "none", "relax"]);
  });
});

/**
 * What each rung composes on, written out rather than read back off the
 * Framing: the kart recordings carry theirs in `samples.ts`, and a face rung
 * keeps every face, the largest leading and the rest by Region id.
 *
 * This is the other half of the partition. Uniqueness alone would pass a
 * Framing that quietly lost a Region from both lists.
 *
 * The kart entries name their rung, and under `DEFAULT_PIN_TO` they would get
 * it anyway since #109 put `kart` ahead of `face`. Naming it keeps the check
 * about the partition rather than about the ladder's order, which is
 * `pinTo`'s promise and is asserted in `kart.test.ts`.
 */
const COMPOSED_ON = [
  ...[...FACE_FIXTURES, ...PODIUM_FIXTURES].map((fixture) => {
    const annotation = Annotation.parse(fixture.raw);
    const faces = annotation.regions
      .filter((region) => region.kind === "face")
      .map((region) => region.id);

    return {
      name: fixture.name,
      annotation,
      ladder: {},
      keptRegionIds: [
        fixture.leadRegionId,
        ...faces.filter((id) => id !== fixture.leadRegionId),
      ],
    };
  }),
  ...KART_FIXTURES.map((fixture) => ({
    name: fixture.name,
    annotation: Annotation.parse(fixture.raw),
    ladder: KART_ONLY,
    keptRegionIds: fixture.keptRegionIds,
  })),
];

describe("kept and dropped partition the Regions the rung composed on", () => {
  for (const { name, annotation, ladder, keptRegionIds } of COMPOSED_ON) {
    for (const { name: shape, target } of TARGETS) {
      it(`loses nobody and doubles nobody: ${name} at ${shape}`, () => {
        const framing = frameCrop({
          annotation,
          request: requestFor(target, ladder),
        });
        const both = [...framing.keptRegionIds, ...framing.droppedRegionIds];

        expect(new Set(both).size).toBe(both.length);
        expect(both).toEqual(keptRegionIds);
      });
    }
  }
});

/** The shapes the property sweep already covers, now with a Subject in them. */
describe("a lone face at every source and shape", () => {
  for (const source of SOURCES) {
    for (const { name, target } of TARGETS) {
      it(`answers with a window: ${source.width}x${source.height} at ${name}`, () => {
        const { window, satisfied, fallback } = frameCrop({
          annotation: facesAnnotation(source, [
            { x: 0.35, y: 0.3, width: 0.3, height: 0.3 },
          ]),
          request: requestFor(target, FACE_ONLY),
        });
        const aspect = target.width / target.height;

        for (const value of Object.values(window)) {
          expect(Number.isInteger(value)).toBe(true);
        }
        expect(window.x).toBeGreaterThanOrEqual(0);
        expect(window.y).toBeGreaterThanOrEqual(0);
        expect(window.x + window.width).toBeLessThanOrEqual(source.width);
        expect(window.y + window.height).toBeLessThanOrEqual(source.height);
        // Both residuals, not the kinder of the two, as `properties.test.ts`
        // reads them: rounding lands on one axis, and asking only that axis
        // would pass a window rounded the wrong way.
        expect(
          Math.abs(window.width - window.height * aspect)
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(window.height - window.width / aspect)
        ).toBeLessThanOrEqual(1);
        expect(satisfied).toBe(fallback === undefined);
      });
    }
  }
});
