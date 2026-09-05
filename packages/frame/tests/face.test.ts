import { describe, expect, it } from "vitest";
import { Annotation, assignRegionIds } from "@meco/contracts";
import { PHI_LINES, frameCrop } from "../index";
import {
  FACE_FIXTURES,
  TARGETS,
  oneFaceAnnotation,
  requestFor,
  vehicleAnnotation,
} from "./samples";

const SQUARE_TARGET = { width: 1080, height: 1080 };
const FACE_ONLY = { pinTo: ["face"] };

/** How far off a Golden Line the Subject may land. The ticket's tolerance. */
const TOLERANCE = 0.02;

describe("the face fixtures", () => {
  for (const { name, raw } of FACE_FIXTURES) {
    it(`parses as a contracts Annotation: ${name}`, () => {
      expect(() => Annotation.parse(raw)).not.toThrow();
    });

    // The ids are not decoration: `leadRegionId` and every tie-break name one.
    // Re-deriving them here binds the fixture to the rule contracts applies,
    // so a fixture numbered by hand cannot drift away from it.
    it(`carries the Region ids contracts assigns: ${name}`, () => {
      const { regions } = Annotation.parse(raw);
      const renumbered = assignRegionIds(
        regions.map(({ id: _id, ...region }) => region)
      );

      expect(renumbered).toEqual(regions);
    });
  }
});

describe("the face rung", () => {
  for (const { name, raw, leadRegionId } of FACE_FIXTURES) {
    it(`leads on the largest face box: ${name}`, () => {
      const framing = frameCrop({
        annotation: Annotation.parse(raw),
        request: requestFor(SQUARE_TARGET, FACE_ONLY),
      });

      expect(framing.resolvedBy).toBe("face");
      expect(framing.leadRegionId).toBe(leadRegionId);
    });

    it(`reports that face as the Subject, and keeps every face: ${name}`, () => {
      const annotation = Annotation.parse(raw);
      const faces = annotation.regions.filter((r) => r.kind === "face");
      const framing = frameCrop({
        annotation,
        request: requestFor(SQUARE_TARGET, FACE_ONLY),
      });

      expect(framing.subject).toEqual(
        faces.find((r) => r.id === leadRegionId)?.box
      );
      expect(framing.keptRegionIds).toEqual(faces.map((r) => r.id));
      expect(framing.droppedRegionIds).toEqual([]);
    });
  }
});

// The rung yields nothing rather than answering badly, and the ladder walks on
// to frame's own last resorts. `pinTo: ["face"]` alone, so nothing else can
// answer and hide it.
describe("the face rung with no face Region", () => {
  const source = { width: 1200, height: 800 };

  it("falls through to the centre when no anchor is named", () => {
    const framing = frameCrop({
      annotation: vehicleAnnotation(source),
      request: requestFor(SQUARE_TARGET, FACE_ONLY),
    });

    expect(framing.resolvedBy).toBe("center");
    expect(framing.leadRegionId).toBeUndefined();
    expect(framing.subject).toBeUndefined();
    expect(framing.keptRegionIds).toEqual([]);
  });

  it("falls through to the anchor when one is named", () => {
    const framing = frameCrop({
      annotation: vehicleAnnotation(source),
      request: requestFor(SQUARE_TARGET, { ...FACE_ONLY, anchor: "top-left" }),
    });

    expect(framing.resolvedBy).toBe("anchor");
    expect(framing.window).toEqual({ x: 0, y: 0, width: 800, height: 800 });
  });
});

/**
 * Every axis of every fixture at every target, with the answer written out
 * rather than re-derived from φ: which Golden Line the Subject should reach,
 * and whether the Source Image lets the window slide that far.
 *
 * `line` indexes {@link PHI_LINES}. `reach: "start"` means the window is up
 * against the top or left edge of the Source Image and the line is out of
 * reach, which is the shape's answer and not the solver's.
 *
 * Axes with no slack are absent on purpose: a cover window touches the Source
 * Image on one axis by construction, so that axis is fixed by the shape. Both
 * 1280x1600 portraits are exactly 4:5, so that target pins them on both.
 */
const GOLDEN_CASES: {
  fixture: string;
  target: string;
  axis: "x" | "y";
  line: 0 | 1;
  reach: "line" | "start";
}[] = [
  {
    fixture: "astronaut-portrait.jpg",
    target: "1:1",
    axis: "y",
    line: 0,
    reach: "start",
  },
  {
    fixture: "astronaut-portrait.jpg",
    target: "9:16",
    axis: "x",
    line: 1,
    reach: "line",
  },
  {
    fixture: "astronaut-portrait.jpg",
    target: "16:9",
    axis: "y",
    line: 0,
    reach: "line",
  },
  {
    fixture: "artemis-2-crew.jpg",
    target: "1:1",
    axis: "y",
    line: 0,
    reach: "line",
  },
  {
    fixture: "artemis-2-crew.jpg",
    target: "9:16",
    axis: "x",
    line: 0,
    reach: "line",
  },
  {
    fixture: "artemis-2-crew.jpg",
    target: "16:9",
    axis: "y",
    line: 0,
    reach: "line",
  },
  {
    fixture: "soyuz-crew.jpg",
    target: "1:1",
    axis: "x",
    line: 0,
    reach: "line",
  },
  {
    fixture: "soyuz-crew.jpg",
    target: "4:5",
    axis: "x",
    line: 0,
    reach: "line",
  },
  {
    fixture: "soyuz-crew.jpg",
    target: "9:16",
    axis: "x",
    line: 0,
    reach: "line",
  },
  {
    fixture: "soyuz-crew.jpg",
    target: "16:9",
    axis: "x",
    line: 0,
    reach: "start",
  },
];

/** One axis of one framing, reduced to the four numbers the checks read. */
const measure = (fixture: string, target: string, axis: "x" | "y") => {
  const entry = FACE_FIXTURES.find((f) => f.name === fixture)!;
  const shape = TARGETS.find((t) => t.name === target)!;
  const annotation = Annotation.parse(entry.raw);
  const lead = annotation.regions.find((r) => r.id === entry.leadRegionId)!;
  const framing = frameCrop({
    annotation,
    request: requestFor(shape.target, FACE_ONLY),
  });

  const across = axis === "x";
  const sourceExtent = across ? annotation.width : annotation.height;
  const windowExtent = across ? framing.window.width : framing.window.height;
  const origin = across ? framing.window.x : framing.window.y;
  const centre = across
    ? lead.box.x + lead.box.width / 2
    : lead.box.y + lead.box.height / 2;

  return {
    slack: sourceExtent - windowExtent,
    origin,
    /** Where the Subject's centre sits in the frame the window cuts. */
    inFrame: (centre * sourceExtent - origin) / windowExtent,
  };
};

describe("the Subject on its Golden Lines", () => {
  // Without this, a solver that stopped sliding altogether would pass every
  // case below by leaving the axis it never touched out of the list.
  it("slides on exactly the axes listed, and no others", () => {
    const withSlack = FACE_FIXTURES.flatMap((fixture) =>
      TARGETS.flatMap(({ name: target }) =>
        (["x", "y"] as const)
          .filter((axis) => measure(fixture.name, target, axis).slack > 0)
          .map((axis) => `${fixture.name} ${target} ${axis}`)
      )
    );

    expect(withSlack).toEqual(
      GOLDEN_CASES.map((c) => `${c.fixture} ${c.target} ${c.axis}`)
    );
  });

  for (const { fixture, target, axis, line, reach } of GOLDEN_CASES) {
    const name = `${fixture} at ${target}, ${axis}`;

    if (reach === "line") {
      it(`puts the Subject on the Golden Line at ${PHI_LINES[line].toFixed(3)}: ${name}`, () => {
        const { inFrame } = measure(fixture, target, axis);

        expect(Math.abs(inFrame - PHI_LINES[line])).toBeLessThanOrEqual(
          TOLERANCE
        );
      });
    } else {
      it(`runs out of Source Image before the line: ${name}`, () => {
        const { origin, inFrame } = measure(fixture, target, axis);

        expect(origin).toBe(0);
        expect(inFrame).toBeLessThan(PHI_LINES[line]);
      });
    }
  }
});

// 1200x800 at 1:1 cuts an 800x800 window with 400 px of slack across, so the
// choice is free and the tie is the only thing deciding it. Down has no slack,
// which is why the face is centred on both axes but only one is read.
describe("a Subject exactly halfway across the Source Image", () => {
  it("takes the upper-left Golden Line, both lines being equally near", () => {
    const framing = frameCrop({
      annotation: oneFaceAnnotation(
        { width: 1200, height: 800 },
        { x: 0.45, y: 0.425, width: 0.1, height: 0.15 }
      ),
      request: requestFor(SQUARE_TARGET, FACE_ONLY),
    });

    const inFrame = (0.5 * 1200 - framing.window.x) / framing.window.width;

    expect(Math.abs(inFrame - PHI_LINES[0])).toBeLessThanOrEqual(TOLERANCE);
  });
});
