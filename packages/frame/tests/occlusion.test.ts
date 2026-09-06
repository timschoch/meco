import { describe, expect, it } from "vitest";
import {
  Annotation,
  type Box,
  type FramingRequest,
  type Size,
} from "@meco/contracts";
import {
  MAX_OCCLUSION_ZONES,
  PHI_LINES,
  frameCrop,
  type FrameInput,
} from "../index";
import {
  FACE_FIXTURES,
  TARGETS,
  emptyAnnotation,
  oneFaceAnnotation,
  requestFor,
  vehicleAnnotation,
} from "./samples";

/** `face` alone, so nothing else can answer and hide what the zones did. */
const FACE_ONLY = { pinTo: ["face"] };
/** `kart` alone: a Region with no landmarks carries no Eye Line, so the window
 * is the cover window and the aim is the only thing left to read. */
const KART_ONLY = { pinTo: ["kart"] };

/** How far off a Golden Line the eyes may land. The same tolerance as #103. */
const TOLERANCE = 0.02;

/**
 * The caption band ADR-0006 measured: full width, from y 0.76 down. It leaves
 * one Free Area, `{ 0, 0, 1, 0.76 }`, and that is the whole point of it — a
 * band whose Free Area needs no sweep to see is the fixture that says what the
 * sweep should have found.
 */
const BAND: Box = { x: 0, y: 0.76, width: 1, height: 0.24 };

/** Where the band's Free Area puts the eyes: `0.382 x 0.76`, or 29.0 %. */
const EYES_UNDER_THE_BAND = PHI_LINES[0] * 0.76;

/**
 * Every face fixture at every shape, which is what the checks below sweep.
 * `pinTo: ["face"]` throughout, so `leadRegionId` is the largest face box and
 * the Eye Line is the rule the band re-expresses.
 */
const CASES = FACE_FIXTURES.flatMap((fixture) =>
  TARGETS.map(({ name: shape, target }) => ({
    name: `${fixture.name} at ${shape}`,
    shape,
    fixture,
    target,
  }))
);

/** The three shapes a portrait is cut to. 16:9 is swept too, never tabled. */
const PORTRAIT_SHAPES = ["1:1", "4:5", "9:16"];

/** One framing of one face fixture, reduced to the numbers the checks read. */
const measure = (
  fixture: { raw: unknown; leadRegionId: string },
  target: Size,
  extra: Record<string, unknown>
) => {
  const annotation = Annotation.parse(fixture.raw);
  const lead = annotation.regions.find((r) => r.id === fixture.leadRegionId)!;
  const eyes = (lead.landmarks!.rEye.y + lead.landmarks!.lEye.y) / 2;
  const framing = frameCrop({
    annotation,
    request: requestFor(target, { ...FACE_ONLY, ...extra }),
  });
  const { window } = framing;
  const source = { width: annotation.width, height: annotation.height };
  /** A Source Image fraction as the output frame sees it, down the frame. */
  const inFrame = (at: number) =>
    (at * source.height - window.y) / window.height;

  return {
    framing,
    window,
    source,
    eyes: inFrame(eyes),
    faceBottom: inFrame(lead.box.y + lead.box.height),
    /** The window sits against the bottom edge, so no lower aim is reachable. */
    pinnedToTheEdge: window.y === source.height - window.height,
  };
};

/**
 * What `frameCrop` answered before Occlusion Zones existed, measured on
 * `origin/main` at d4dd3d6 and written out rather than re-derived.
 *
 * This is the ticket's "deep-equal to the same request without the field",
 * written the only way the schema allows: `FramingRequest.occlusion` is
 * required, so a request without the field does not parse, and the promise
 * that an empty list changes nothing has to be made against the behaviour that
 * shipped before the field did anything.
 */
const BEFORE_ANY_ZONE: Record<string, string> = {
  "astronaut-portrait.jpg at 1:1": "56,0,1003x1003",
  "astronaut-portrait.jpg at 4:5": "180,0,802x1003",
  "astronaut-portrait.jpg at 9:16": "327,0,564x1003",
  "astronaut-portrait.jpg at 16:9": "0,108,1280x720",
  "artemis-2-crew.jpg at 1:1": "0,145,1280x1280",
  "artemis-2-crew.jpg at 4:5": "30,37,1250x1563",
  "artemis-2-crew.jpg at 9:16": "292,37,879x1563",
  "artemis-2-crew.jpg at 16:9": "0,359,1280x720",
  "soyuz-crew.jpg at 1:1": "92,0,695x695",
  "soyuz-crew.jpg at 4:5": "144,0,557x696",
  "soyuz-crew.jpg at 9:16": "208,0,391x695",
  "soyuz-crew.jpg at 16:9": "0,0,1236x695",
};

const asText = (window: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => `${window.x},${window.y},${window.width}x${window.height}`;

/**
 * An empty list is not a special case in the code, it is the absence of one:
 * the Free Area machinery runs only when a Template declared a zone. These are
 * the checks that make that structural rather than incidental.
 */
describe("an empty occlusion list", () => {
  for (const { name, fixture, target } of CASES) {
    it(`leaves the window exactly where it was: ${name}`, () => {
      const { window } = measure(fixture, target, { occlusion: [] });

      expect(asText(window)).toBe(BEFORE_ANY_ZONE[name]);
    });

    it(`reports no occlusionClear at all: ${name}`, () => {
      const { framing } = measure(fixture, target, { occlusion: [] });

      expect("occlusionClear" in framing).toBe(false);
    });
  }

  // The sweep above is the `face` rung. `occlusionClear` is the one field an
  // empty list could add, and it must be absent whichever rung answered — the
  // two that compose no Subject at all included, where a vacuous `true` would
  // be the easy mistake.
  const EVERY_RUNG: { name: string; input: FrameInput }[] = [
    {
      name: "the kart rung",
      input: {
        annotation: vehicleAnnotation({ width: 1200, height: 800 }),
        request: requestFor(
          { width: 1080, height: 1080 },
          { ...KART_ONLY, occlusion: [] }
        ),
      },
    },
    {
      name: "the centre, with nothing composed",
      input: {
        annotation: emptyAnnotation({ width: 1200, height: 800 }),
        request: requestFor({ width: 1080, height: 1080 }, { occlusion: [] }),
      },
    },
    {
      name: "the Crop Anchor, with nothing composed",
      input: {
        annotation: emptyAnnotation({ width: 1200, height: 800 }),
        request: requestFor(
          { width: 1080, height: 1080 },
          { anchor: "top-left", occlusion: [] }
        ),
      },
    },
    {
      name: "a declared Subject Area",
      input: {
        annotation: oneFaceAnnotation(
          { width: 2000, height: 2000 },
          { x: 0.4, y: 0.3, width: 0.1, height: 0.2 }
        ),
        request: requestFor(
          { width: 1080, height: 1080 },
          {
            ...FACE_ONLY,
            subjectArea: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
            occlusion: [],
          }
        ),
      },
    },
  ];

  for (const { name, input } of EVERY_RUNG) {
    it(`adds no field on ${name}`, () => {
      expect("occlusionClear" in frameCrop(input)).toBe(false);
    });
  }
});

/**
 * ADR-0006's measured table, reproduced. An overlay does not switch the
 * composition rule off, it re-expresses it inside what the overlay leaves:
 * the eyes reach the upper Golden Line of the Free Area, `0.382 x 0.76`.
 *
 * The rows that do not move are the case ADR-0001 already names. A window
 * already against the bottom edge of the Source Image has nowhere lower to go,
 * and the aim is simply out of reach — the same shape-not-solver answer as an
 * axis with no slack. The check reads that off the window rather than naming
 * the rows, and the count below stops a mutation pinning everything from
 * passing an empty sweep.
 */
describe("a caption band from y 0.76", () => {
  for (const { name, shape, fixture, target } of CASES) {
    if (!PORTRAIT_SHAPES.includes(shape)) continue;

    it(`aims the eyes at the Free Area's Golden Line: ${name}`, () => {
      const banded = measure(fixture, target, { occlusion: [BAND] });
      const bare = measure(fixture, target, { occlusion: [] });

      const expected = banded.pinnedToTheEdge ? bare.eyes : EYES_UNDER_THE_BAND;

      expect(Math.abs(banded.eyes - expected)).toBeLessThanOrEqual(TOLERANCE);
    });
  }

  it("moves seven of the nine, and the two it cannot are against the edge", () => {
    const rows = CASES.filter(({ shape }) => PORTRAIT_SHAPES.includes(shape));
    const stuck = rows
      .filter(
        ({ fixture, target }) =>
          measure(fixture, target, { occlusion: [BAND] }).pinnedToTheEdge
      )
      .map(({ name }) => name);

    // ADR-0006's table reads 6 of 9 moved against a prototype; the shipped
    // headroom zoom of #103 buys one more row the slack to move. Measured, not
    // inherited.
    expect(stuck).toEqual([
      "artemis-2-crew.jpg at 4:5",
      "artemis-2-crew.jpg at 9:16",
    ]);
  });

  it("says 29.0 % in the ADR's own units", () => {
    expect(EYES_UNDER_THE_BAND).toBeCloseTo(0.29, 3);
  });

  for (const { name, fixture, target } of CASES) {
    it(`never changes the window size: ${name}`, () => {
      const banded = measure(fixture, target, { occlusion: [BAND] });
      const bare = measure(fixture, target, { occlusion: [] });

      // No zoom clears an overlay. ADR-0006, "Why occlusion aims but does not
      // size": zooming in makes the Subject larger in the frame and so more
      // likely to touch the band, and zooming out is impossible past the cover
      // window. The only motion that clears a zone is an aim.
      expect(banded.window.width).toBe(bare.window.width);
      expect(banded.window.height).toBe(bare.window.height);
    });

    it(`lands the leading face clear of the band: ${name}`, () => {
      const { faceBottom, framing } = measure(fixture, target, {
        occlusion: [BAND],
      });

      expect(faceBottom).toBeLessThanOrEqual(BAND.y);
      expect(framing.occlusionClear).toBe(true);
    });
  }
});

/**
 * The clamp on its own, and then the Source Image overruling it.
 *
 * A Golden Line measured off the Free Area is not enough by itself: a Subject
 * large enough for the line it is nearest to still runs off the edge of what
 * the overlay leaves. The clamp is what moves the aim the rest of the way, and
 * `occlusionClear` is read off the window that came out, not off the aim that
 * went in — the two disagree exactly when the picture ran out.
 *
 * The vehicle fixture carries no landmarks, so no Eye Line sizes anything and
 * the aim is the only thing under test. 16:9 over a tall source fills the
 * width, so the vertical is the axis with slack and the zone is a full-width
 * band across the lower half.
 */
describe("the aim clamped into the Free Area", () => {
  const TALL_BAND: Box = { x: 0, y: 0.5, width: 1, height: 0.5 };
  const WIDE: Size = { width: 1920, height: 1080 };

  const framed = (source: Size, box: Box) => {
    const framing = frameCrop({
      annotation: vehicleAnnotation(source, box),
      request: requestFor(WIDE, { ...KART_ONLY, occlusion: [TALL_BAND] }),
    });
    const { window } = framing;

    return {
      framing,
      window,
      /** The Subject's lower edge as the output frame sees it. */
      subjectBottom:
        ((box.y + box.height) * source.height - window.y) / window.height,
      againstTheEdge: window.y === source.height - window.height,
    };
  };

  it("moves the aim off the Golden Line rather than let the Subject touch", () => {
    // 1000x2000 cuts a 1000x563 window. The Subject's centre sits at 0.625, so
    // its nearest Golden Line is the lower one, and 0.618 of the Free Area is
    // 0.309 — which puts 250 px of Subject, 0.444 of the window, from 0.087 to
    // 0.531 and 0.031 of it under the band. The clamp answers 0.278 instead.
    const { framing, subjectBottom, againstTheEdge } = framed(
      { width: 1000, height: 2000 },
      { x: 0.4, y: 0.5625, width: 0.2, height: 0.125 }
    );

    expect(againstTheEdge).toBe(false);
    expect(subjectBottom).toBeLessThanOrEqual(TALL_BAND.y);
    expect(framing.occlusionClear).toBe(true);
  });

  it("reports the miss when the picture's own edge overrules the clamp", () => {
    // The same Subject 1100 px down a 1100 px picture. The clamped aim asks the
    // window to start at 724 px and the Source Image holds only 537, so the
    // window slides back up and the Subject lands on the band after all. The
    // aim was clear; the window is not, and the window is what is reported.
    const { framing, subjectBottom, againstTheEdge } = framed(
      { width: 1000, height: 1100 },
      { x: 0.4, y: 0.6864, width: 0.2, height: 0.2273 }
    );

    expect(againstTheEdge).toBe(true);
    expect(subjectBottom).toBeGreaterThan(TALL_BAND.y);
    expect(framing.occlusionClear).toBe(false);
  });
});

/**
 * The two rungs that compose no Subject. `occlusionClear` says something about
 * a Subject, so with none there is nothing for it to say and the field is
 * absent — not a vacuous `true`, which is the lie #136 took out of `subject`:
 * a value every rung of the ladder holds without meaning it.
 *
 * The window is still placed, and the zones still went unread. Nothing here is
 * a refusal.
 */
describe("Occlusion Zones with nothing composed", () => {
  const SOURCE: Size = { width: 1200, height: 800 };
  const SQUARE: Size = { width: 1080, height: 1080 };

  const framing = (extra: Record<string, unknown>) =>
    frameCrop({
      annotation: emptyAnnotation(SOURCE),
      request: requestFor(SQUARE, { occlusion: [BAND], ...extra }),
    });

  for (const [rung, extra] of [
    ["the centre", {}],
    ["the Crop Anchor", { anchor: "top-left" }],
  ] as const) {
    it(`reports no occlusionClear on ${rung}`, () => {
      const framed = framing(extra);

      expect(framed.subject).toBeUndefined();
      expect("occlusionClear" in framed).toBe(false);
      // The band changed nothing, because there was nothing to keep off it.
      expect(framed.window).toEqual(
        frameCrop({
          annotation: emptyAnnotation(SOURCE),
          request: requestFor(SQUARE, { occlusion: [], ...extra }),
        }).window
      );
    });
  }
});

/**
 * `occlusionClear` is a measurement, never a verdict on the request. frame
 * answers every geometry it is given, so a zone nothing can clear still gets a
 * window and the miss is what is reported.
 */
describe("a zone that cannot be cleared", () => {
  const SOURCE: Size = { width: 1000, height: 1000 };
  const WIDE: Size = { width: 1920, height: 1080 };
  /** A face filling most of the picture, against a zone filling most of the frame. */
  const BIG_FACE: Box = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
  const MOST_OF_THE_FRAME: Box = { x: 0, y: 0.2, width: 1, height: 0.8 };

  const framing = () =>
    frameCrop({
      annotation: oneFaceAnnotation(SOURCE, BIG_FACE),
      request: requestFor(WIDE, {
        ...FACE_ONLY,
        occlusion: [MOST_OF_THE_FRAME],
      }),
    });

  it("still returns a window", () => {
    // The same 1000x563 the no-zone case answers: the Free Area aimed, and an
    // aim is all it did.
    expect({
      width: framing().window.width,
      height: framing().window.height,
    }).toEqual({ width: 1000, height: 563 });
  });

  it("reports the miss rather than refusing", () => {
    expect(framing().occlusionClear).toBe(false);
  });
});

/**
 * A Subject Area and Occlusion Zones together. The Free Area is their
 * intersection, and the area wins outright when there is none.
 *
 * An area that sizes the window sizes it so the Subject exactly fills the area,
 * so an overlay that covers part of that area always leaves the Subject bigger
 * than what is left. The aim is then the centre of the Free Area whichever way
 * it is reached, and both misses are reported: the Subject is off the area it
 * was told to fill, and still on the zone it was told to avoid. That is not a
 * gap in the checks, it is what declaring both against one another means.
 */
describe("a Subject Area under a caption band", () => {
  const soyuz = FACE_FIXTURES[2]!;
  const SQUARE: Size = { width: 1080, height: 1080 };
  /** #103's area, whose framing that ticket pinned at 340x340. */
  const MIDDLE: Box = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };

  const framing = (occlusion: Box[]) =>
    measure(soyuz, SQUARE, { subjectArea: MIDDLE, occlusion });

  it("aims at the centre of what the band leaves of the area", () => {
    // The area runs 0.2 to 0.8 and the band leaves 0 to 0.76, so the Free Area
    // runs 0.2 to 0.76 and its centre is 0.48 rather than 0.50. The leading
    // face sits at 0.3779 of a 777 px picture and the window is 340 px tall:
    // 293.6 - 0.48 x 340 = 130.4 against 293.6 - 0.50 x 340 = 123.6.
    expect(framing([]).window.y).toBe(124);
    expect(framing([BAND]).window.y).toBe(130);
  });

  it("leaves the sizing to the area alone", () => {
    const { window } = framing([BAND]);

    expect({ width: window.width, height: window.height }).toEqual({
      width: 340,
      height: 340,
    });
  });

  it("reports both misses when the two disagree", () => {
    const { framing: framed } = framing([BAND]);

    expect(framed.occlusionClear).toBe(false);
    // Satisfaction is containment on the window actually cut, so an aim the
    // Free Area moved is an area missed. #106 owns the field; this is the
    // second of the three ways it can go false.
    expect(framed.subjectAreaSatisfied).toBe(false);
  });
});

/**
 * An area the band leaves nothing of. The area wins — somebody said where the
 * Subject goes and frame does not overrule that on its own — and the miss shows
 * up where every other one does, in a measurement on the window actually cut.
 */
describe("a Subject Area the band leaves nothing of", () => {
  const SOURCE: Size = { width: 2000, height: 3000 };
  const SQUARE: Size = { width: 1080, height: 1080 };
  /** Small enough that the area sizes the window rather than the picture. */
  const FACE: Box = { x: 0.45, y: 0.45, width: 0.1, height: 0.1 };
  /** Entirely below the band, so the intersection is empty. */
  const UNDER_THE_BAND: Box = { x: 0.2, y: 0.8, width: 0.6, height: 0.2 };

  const framing = (occlusion: Box[]) =>
    frameCrop({
      annotation: oneFaceAnnotation(SOURCE, FACE),
      request: requestFor(SQUARE, {
        ...FACE_ONLY,
        subjectArea: UNDER_THE_BAND,
        occlusion,
      }),
    });

  it("places the window exactly where the area alone would", () => {
    expect(framing([BAND]).window).toEqual(framing([]).window);
    // 300 px of face filling 0.2 of the frame asks for a 1500 px window, and
    // the aim at 0.9 of it puts the face at 0.8 to 1.0 — inside the area, and
    // inside the band with it.
    expect(framing([BAND]).window).toEqual({
      x: 250,
      y: 150,
      width: 1500,
      height: 1500,
    });
  });

  it("reports the zone missed and the area kept", () => {
    expect(framing([BAND]).occlusionClear).toBe(false);
    expect(framing([BAND]).subjectAreaSatisfied).toBe(true);
  });
});

/**
 * The tie-breaks, pinned on shapes built to tie. Read through the window,
 * because the Free Area is not on the seam: which rectangle won is visible
 * only in where the window ended up.
 *
 * The vehicle fixture carries no landmarks, so no Eye Line sizes anything and
 * the window is the cover window. A cover window touches the Source Image on
 * one axis by construction, so each case reads the one axis that has slack.
 */
describe("which rectangle the Free Area sweep picks", () => {
  const SOURCE: Size = { width: 1000, height: 1000 };
  const WIDE: Size = { width: 1920, height: 1080 };
  const TALL: Size = { width: 1080, height: 1920 };

  /** A cross: four quadrants of 0.45 x 0.45, tied on area and on centre. */
  const CROSS: Box[] = [
    { x: 0.45, y: 0, width: 0.1, height: 1 },
    { x: 0, y: 0.45, width: 1, height: 0.1 },
  ];

  const windowFor = (box: Box, target: Size, occlusion: Box[]) =>
    frameCrop({
      annotation: vehicleAnnotation(SOURCE, box),
      request: requestFor(target, { ...KART_ONLY, occlusion }),
    }).window;

  it("breaks a four-way tie on the lowest y", () => {
    // 16:9 over a square source cuts 1000x563, so only the vertical has slack.
    // The top-left quadrant aims the Subject's centre at 0.382 x 0.45 = 0.1719
    // of the window: y = round(500 - 0.1719 x 563) = 403. The bottom-left
    // quadrant, tied on area and on distance to the frame centre, would aim at
    // 0.55 + 0.1719 and answer 94.
    expect(
      windowFor({ x: 0.05, y: 0.45, width: 0.1, height: 0.1 }, WIDE, CROSS).y
    ).toBe(403);
  });

  it("breaks the remaining tie on the lowest x", () => {
    // 9:16 over the same source cuts 563x1000, so only the horizontal has
    // slack. Same arithmetic across the frame: 403 for the left quadrants, 94
    // for the right.
    expect(
      windowFor({ x: 0.45, y: 0.05, width: 0.1, height: 0.1 }, TALL, CROSS).x
    ).toBe(403);
  });

  it("prefers the largest rectangle over the one on the frame centre", () => {
    // Two opposite corners blocked leave four candidates: two of 0.6 x 0.6 in
    // the other corners, and two strips of 0.2 dead on the frame centre. Area
    // is read first, so the top-left 0.36 wins and its Golden Line answers
    // 0.382 x 0.6 = 0.2292: y = round(500 - 0.2292 x 563) = 371. A rule that
    // read the centre first would take a strip and answer 285.
    const corners: Box[] = [
      { x: 0, y: 0, width: 0.4, height: 0.4 },
      { x: 0.6, y: 0.6, width: 0.4, height: 0.4 },
    ];

    expect(
      windowFor({ x: 0.45, y: 0.45, width: 0.1, height: 0.1 }, WIDE, corners).y
    ).toBe(371);
  });

  it("prefers the rectangle nearest the frame centre over the lowest x", () => {
    // Two bands leave three strips of exactly 0.3 x 1. The middle one sits on
    // the frame centre at distance 0, the outer two at 0.35. Its Golden Line is
    // 0.35 + 0.382 x 0.3 = 0.4646, so x = round(500 - 0.4646 x 563) = 238; the
    // left strip would have answered 436.
    const bands: Box[] = [
      { x: 0.3, y: 0, width: 0.05, height: 1 },
      { x: 0.65, y: 0, width: 0.05, height: 1 },
    ];

    expect(
      windowFor({ x: 0.45, y: 0.45, width: 0.1, height: 0.1 }, TALL, bands).x
    ).toBe(238);
  });
});

/**
 * A Subject that already fits what the overlay leaves. The Free Area narrows
 * where the Subject may land; it does not move a Subject that was never in the
 * way. This is the case the two readings of `docs/specs/frame.md` step 3 pull
 * apart — aiming at the centre of the Free Area against clamping the aim into
 * it — and the spec's own words are the clamp.
 */
describe("a Subject Area the band narrows but does not reach", () => {
  const SOURCE: Size = { width: 2000, height: 3000 };
  const SQUARE: Size = { width: 1080, height: 1080 };
  const FACE: Box = { x: 0.45, y: 0.45, width: 0.1, height: 0.1 };
  /** Narrow enough that the picture cannot fill it: 200 px of face across
   * 0.05 of the frame asks for a 4000 px window and the picture holds 2000. */
  const NARROW: Box = { x: 0.05, y: 0.3, width: 0.05, height: 0.6 };

  const framing = (occlusion: Box[]) =>
    frameCrop({
      annotation: oneFaceAnnotation(SOURCE, FACE),
      request: requestFor(SQUARE, {
        ...FACE_ONLY,
        subjectArea: NARROW,
        occlusion,
      }),
    });

  it("leaves the window exactly where the area alone put it", () => {
    // The band cuts the area from 0.3-0.9 down to 0.3-0.76, so its centre moves
    // from 0.60 to 0.53 — but the Subject is 0.15 of the window against 0.46 of
    // Free Area, so it fits at 0.60 and nothing has to move. Aiming at the
    // Free Area's centre instead would answer y 440.
    expect(framing([BAND]).window).toEqual(framing([]).window);
    expect(framing([BAND]).window).toEqual({
      x: 0,
      y: 300,
      width: 2000,
      height: 2000,
    });
  });

  it("still says the picture fell short of the area", () => {
    expect(framing([BAND]).subjectAreaShortfall).toBeCloseTo(2, 3);
    expect(framing([BAND]).occlusionClear).toBe(true);
  });
});

/**
 * The cap is the contracts schema's: `FramingRequest.occlusion` is
 * `z.array(Box).max(16)`, so the gateway refuses a longer list with a 400 and
 * frame never sees one in production. What is asserted here is frame's
 * defensive guard underneath that wall, which is why the over-long request is
 * built past the schema rather than parsed through it — a parsed one cannot
 * exist.
 */
describe("the occlusion cap", () => {
  const SOURCE: Size = { width: 1000, height: 1000 };
  const SQUARE: Size = { width: 1080, height: 1080 };

  /** Staggered on both axes, so the sweep meets its worst case: every zone
   * contributes two x edges and two y edges nothing else shares. */
  const zones = (count: number): Box[] =>
    Array.from({ length: count }, (_, i) => ({
      x: i * 0.055,
      y: i * 0.055,
      width: 0.05,
      height: 0.05,
    }));

  const withZones = (occlusion: Box[]) =>
    frameCrop({
      annotation: vehicleAnnotation(SOURCE),
      request: {
        ...requestFor(SQUARE, KART_ONLY),
        occlusion,
      } as FramingRequest,
    });

  it(`answers ${MAX_OCCLUSION_ZONES} zones`, () => {
    expect(withZones(zones(MAX_OCCLUSION_ZONES)).window.width).toBeGreaterThan(
      0
    );
  });

  it("refuses one more", () => {
    expect(() => withZones(zones(MAX_OCCLUSION_ZONES + 1))).toThrow(RangeError);
  });
});
