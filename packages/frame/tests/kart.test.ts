import { describe, expect, it } from "vitest";
import { Annotation, assignRegionIds, type Box } from "@meco/contracts";
import { frameCrop } from "../index";
import {
  KART_FIXTURES,
  PODIUM_FIXTURES,
  oneFaceAnnotation,
  requestFor,
} from "./samples";

const SQUARE_TARGET = { width: 1080, height: 1080 };
const KART_ONLY = { pinTo: ["kart"] };

/**
 * How far the composed Subject may sit from the recording, per side. The
 * ticket's tolerance. The recorded boxes carry four decimals and the union is
 * built from those same four decimals, so the room this leaves is for
 * arithmetic and not for a different answer.
 */
const TOLERANCE = 1.5e-3;

/**
 * Which sides are within {@link TOLERANCE} of the recording, side by side, so
 * that a failure names the one that drifted rather than handing back a number.
 */
const within = (got: Box, want: Box): Record<keyof Box, boolean> => ({
  x: Math.abs(got.x - want.x) <= TOLERANCE,
  y: Math.abs(got.y - want.y) <= TOLERANCE,
  width: Math.abs(got.width - want.width) <= TOLERANCE,
  height: Math.abs(got.height - want.height) <= TOLERANCE,
});

/** One `frameCrop` on the `kart` rung alone, so nothing else can answer. */
const frameOnKart = (raw: unknown, extra: Record<string, unknown> = {}) =>
  frameCrop({
    annotation: Annotation.parse(raw),
    request: requestFor(SQUARE_TARGET, { ...KART_ONLY, ...extra }),
  });

describe("the kart fixtures", () => {
  for (const { name, raw } of KART_FIXTURES) {
    it(`parses as a contracts Annotation: ${name}`, () => {
      expect(() => Annotation.parse(raw)).not.toThrow();
    });

    // `leadRegionId` and every kept Region name an id, so the fixture must be
    // numbered by the rule contracts applies and not by hand.
    it(`carries the Region ids contracts assigns: ${name}`, () => {
      const { regions } = Annotation.parse(raw);
      const renumbered = assignRegionIds(
        regions.map(({ id: _id, ...region }) => region)
      );

      expect(renumbered).toEqual(regions);
    });
  }
});

describe("the kart rung", () => {
  for (const {
    name,
    raw,
    leadRegionId,
    keptRegionIds,
    subject,
  } of KART_FIXTURES) {
    it(`composes the Subject the prototype recorded: ${name}`, () => {
      const framing = frameOnKart(raw);

      expect(framing.subject).toBeDefined();
      expect(within(framing.subject!, subject)).toEqual({
        x: true,
        y: true,
        width: true,
        height: true,
      });
    });

    it(`names the seed Region and everything joined to it: ${name}`, () => {
      const framing = frameOnKart(raw);

      expect(framing.resolvedBy).toBe("kart");
      expect(framing.leadRegionId).toBe(leadRegionId);
      expect(framing.keptRegionIds).toEqual(keptRegionIds);
      expect(framing.droppedRegionIds).toEqual([]);
    });
  }
});

/**
 * The overlap is a share of the smaller box, and it has to be: a driver's box
 * is a fraction of the kart's, so the two have a small IoU even when the driver
 * sits entirely inside the kart. `on-track-rear-helmet.jpg` is the case in its
 * clearest form — one kart, one driver, and the driver must join.
 */
describe("overlap measured against the smaller box", () => {
  const { raw, subject } = KART_FIXTURES.find(
    (f) => f.name === "on-track-rear-helmet.jpg"
  )!;
  const annotation = Annotation.parse(raw);
  const kart = annotation.regions.find((r) => r.id === "vehicle-1")!;
  const driver = annotation.regions.find((r) => r.id === "person-1")!;

  // Re-derived here rather than imported: `lib/boxes.ts` is private to the
  // package, and a check on the rule's own arithmetic would prove nothing.
  const area = (b: Box) => b.width * b.height;
  const intersection =
    Math.max(
      0,
      Math.min(kart.box.x + kart.box.width, driver.box.x + driver.box.width) -
        Math.max(kart.box.x, driver.box.x)
    ) *
    Math.max(
      0,
      Math.min(kart.box.y + kart.box.height, driver.box.y + driver.box.height) -
        Math.max(kart.box.y, driver.box.y)
    );

  it("has an IoU below the 0.25 an overlap-of-the-smaller-box clears", () => {
    const iou =
      intersection / (area(kart.box) + area(driver.box) - intersection);
    const ofSmaller = intersection / Math.min(area(kart.box), area(driver.box));

    expect(iou).toBeLessThan(0.25);
    expect(ofSmaller).toBeGreaterThan(0.25);
  });

  it("joins the driver anyway, and the Subject reaches over the helmet", () => {
    const framing = frameOnKart(raw);

    expect(framing.keptRegionIds).toContain(driver.id);
    // The kart box stops below the helmet; the recorded Subject does not.
    expect(framing.subject!.y).toBeLessThan(kart.box.y);
    expect(framing.subject!.y).toBeCloseTo(subject.y, 3);
  });
});

/**
 * The seed is the largest `vehicle` box, not the highest-scoring one.
 * `paddock-mixed.jpg` is where the two disagree: `vehicle-2` outscores
 * `vehicle-1` while covering half the frame area it does, so a score seed
 * would compose the union around the wrong kart.
 */
describe("the seed is the largest box and not the best score", () => {
  const { raw, leadRegionId } = KART_FIXTURES.find(
    (f) => f.name === "paddock-mixed.jpg"
  )!;
  const annotation = Annotation.parse(raw);

  it("holds two vehicles, and the smaller one scores higher", () => {
    const largest = annotation.regions.find((r) => r.id === "vehicle-1")!;
    const best = annotation.regions.find((r) => r.id === "vehicle-2")!;

    expect(best.score).toBeGreaterThan(largest.score);
    expect(best.score).toBeCloseTo(0.4453, 4);
    expect(largest.score).toBeCloseTo(0.3451, 4);
    expect(best.box.width * best.box.height).toBeLessThan(
      largest.box.width * largest.box.height
    );
  });

  it("seeds on the largest", () => {
    const framing = frameOnKart(raw);

    expect(framing.leadRegionId).toBe(leadRegionId);
    expect(framing.leadRegionId).toBe("vehicle-1");
  });
});

/**
 * No vehicle, no kart. The rung composes nothing on a photograph that holds
 * only people, so the ladder walks past it to whatever `pinTo` names next.
 *
 * It used to seed on the largest `person` instead, which framed a body and
 * still called itself `kart`. That was the wrong shape, and #109's re-record
 * is what proved it: with `kart` ahead of `face` in `DEFAULT_PIN_TO`, the
 * fallback caught every portrait D-FINE draws a body on — five of the nine
 * recordings — and the Eye Line never ran on any of them.
 */
describe("no vehicle Region", () => {
  const { raw } = PODIUM_FIXTURES.find((f) => f.name === "podium-trophy.jpg")!;
  const annotation = Annotation.parse(raw);

  it("holds people and no vehicle at all", () => {
    expect(annotation.regions.filter((r) => r.kind === "vehicle")).toEqual([]);
    expect(
      annotation.regions.filter((r) => r.kind === "person").length
    ).toBeGreaterThan(0);
  });

  it("composes nothing, and the ladder falls through to the centre", () => {
    const framing = frameOnKart(raw);

    expect(framing.resolvedBy).toBe("center");
    expect(framing.leadRegionId).toBeUndefined();
    expect(framing.subject).toBeUndefined();
    expect(framing.keptRegionIds).toEqual([]);
  });

  it("lets the face rung answer it under the default ladder", () => {
    const framing = frameCrop({
      annotation,
      request: requestFor(SQUARE_TARGET),
    });

    expect(framing.resolvedBy).toBe("face");
  });
});

/**
 * The crowd problem disappearing without a rule about crowds: a spectator does
 * not overlap the kart, so the join leaves them out on its own.
 */
describe("a paddock full of people", () => {
  const { raw, keptRegionIds } = KART_FIXTURES.find(
    (f) => f.name === "paddock-mixed.jpg"
  )!;
  const annotation = Annotation.parse(raw);

  it("holds twenty-five person Regions and two vehicles", () => {
    expect(annotation.regions.filter((r) => r.kind === "person")).toHaveLength(
      25
    );
    expect(annotation.regions.filter((r) => r.kind === "vehicle")).toHaveLength(
      2
    );
  });

  it("keeps only the eight people at the kart", () => {
    const framing = frameOnKart(raw);
    const keptPeople = framing.keptRegionIds.filter((id) =>
      id.startsWith("person-")
    );

    expect(framing.keptRegionIds).toEqual(keptRegionIds);
    expect(keptPeople).toHaveLength(8);
  });

  it("leaves the other seventeen standing in the paddock out of it", () => {
    const framing = frameOnKart(raw);
    const standing = annotation.regions.filter(
      (r) => r.kind === "person" && !framing.keptRegionIds.includes(r.id)
    );

    // 25 people, 8 joined. None of the rest widened the union — and some of
    // them still fall inside the Subject it came out at, `person-5` among
    // them, which is what a kept Region does not mean: it names what the rung
    // composed on, not what the window happens to hold.
    expect(standing).toHaveLength(17);
  });
});

/**
 * Selection is on Region Kind and never on a Label, so replacing the Model that
 * draws the boxes moves nothing here. Asserted the only way that stays true
 * when the rule changes: every Label becomes a nonsense string and the Framing
 * must not move by one pixel.
 */
describe("the kart rung never reads a Label", () => {
  const NONSENSE = "nrrrrrgh";

  for (const { name, raw } of KART_FIXTURES) {
    it(`answers identically with every Label replaced: ${name}`, () => {
      const annotation = Annotation.parse(raw);
      const relabelled = Annotation.parse({
        ...annotation,
        regions: annotation.regions.map((region) => ({
          ...region,
          label: NONSENSE,
        })),
      });

      expect(frameOnKart(relabelled)).toEqual(frameOnKart(raw));
    });
  }
});

/**
 * A face is neither a vehicle nor a person, so the rung has nothing to seed on
 * and the ladder walks past it. `pinTo: ["kart"]` alone, so nothing else can
 * answer and hide it.
 */
describe("the kart rung with no vehicle and no person Region", () => {
  const source = { width: 1200, height: 800 };
  const faceOnly = oneFaceAnnotation(source, {
    x: 0.45,
    y: 0.425,
    width: 0.1,
    height: 0.15,
  });

  it("falls through to the centre when no anchor is named", () => {
    const framing = frameOnKart(faceOnly);

    expect(framing.resolvedBy).toBe("center");
    expect(framing.leadRegionId).toBeUndefined();
    expect(framing.subject).toBeUndefined();
    expect(framing.keptRegionIds).toEqual([]);
  });

  it("falls through to the anchor when one is named", () => {
    const framing = frameOnKart(faceOnly, { anchor: "top-left" });

    expect(framing.resolvedBy).toBe("anchor");
    expect(framing.window).toEqual({ x: 0, y: 0, width: 800, height: 800 });
  });
});
