import { beforeAll, describe, expect, it } from "vitest";
import { redact, type RedactRequest } from "../index";
import {
  crewRegions,
  decodeCrew,
  faceOnTheStep,
  matchOf,
  smallestFace,
  STEP_EDGE_SIZE,
  stepEdge,
} from "./samples";
import {
  boundsOf,
  changedBounds,
  changedChannels,
  countPixels,
  CORE_RADIUS,
  grownBy,
  inBand,
  insideCore,
  meanChange,
  meanLaplacian,
  outsideEvery,
  rectangleOf,
  riseAcross,
  sigmaBehind,
  type Rectangle,
} from "./pixels";

let image: RedactRequest["image"];
/** The four faces hidden, which is what `matches: []` asks for. */
let masked: RedactRequest["image"];
let rects: Rectangle[];

const call = (over: Partial<Omit<RedactRequest, "image">>): RedactRequest => ({
  image,
  regions: crewRegions,
  matches: [],
  redaction: { blurUnknownFaces: true },
  ...over,
});

beforeAll(async () => {
  image = await decodeCrew();
  rects = crewRegions.map((region) => rectangleOf(region.box, image));
  masked = (await redact(call({}))).image;
});

describe("the Redaction Mask", () => {
  // Mutation (a): remove the `.blur()` call — the ratio returns to 1.00.
  // Mutation (b): paint the mask on a rectangle offset by half its width, so
  // half of each face keeps its own pixels — 0.72 to 0.75.
  //
  // Offsetting only the rectangle the blur is *read* from leaves this green,
  // and rightly: the face is then covered in blurred neighbouring pixels,
  // which is smooth, which is what this check measures. The sigma check below
  // is what catches that one.
  //
  // Halving the sigma is NOT a valid mutation for this check and is not
  // shipped as one: ADR-0008 measured the curve flat from k = 0.2, so k =
  // 0.125 stays well under the bound here. It is caught below instead, where
  // the sigma is measured rather than inferred from what it left behind.
  it.each([1, 2, 3, 4])(
    "leaves face-%i under a fifth of its detail inside the opaque core",
    (id) => {
      const rect = rects[id - 1]!;
      const core = insideCore(rect);

      const was = meanLaplacian(image, rect, core);
      const now = meanLaplacian(masked, rect, core);

      expect(was).toBeGreaterThan(0);
      expect(now / was).toBeLessThan(0.2);
    }
  );

  // Mutation: a hard edge — coverage 1 everywhere inside the ellipse. Then the
  // rim changes as much as the core does and both bounds go.
  //
  // The feather earns its place outside this suite, once `compose` resamples
  // the frame: ADR-0008 measured a hard edge leaking past the ellipse over 4
  // times as far at 32 times the amplitude. What is measurable here is that
  // the ramp exists at all, so the property cannot be deleted in silence.
  it.each([1, 2, 3, 4])(
    "fades face-%i out over the outer sixth rather than stopping at an edge",
    (id) => {
      const rect = rects[id - 1]!;
      const change = (from: number, to: number): number =>
        meanChange(image, masked, rect, inBand(rect, from, to));

      const core = change(0, CORE_RADIUS);
      expect(core).toBeGreaterThan(10);
      expect(change(0.9, 0.95)).toBeLessThan(core / 2);
      expect(change(0.98, 1)).toBeLessThan(core / 10);
    }
  );

  // Mutation (c): blur the whole image and composite the ellipses over it.
  // ADR-0008 measured that route changing 1 998 191 of 2 005 042 pixels
  // outside the ellipses, which is the promise gone rather than dented.
  it("changes no pixel outside any of the four ellipses", () => {
    const untouched = outsideEvery(rects);
    const bounds = boundsOf(image);

    const examined = countPixels(bounds, untouched);
    expect(examined).toBeGreaterThan(1_900_000);
    expect(examined).toBeLessThan(image.width * image.height);

    expect(changedChannels(image, masked, bounds, untouched)).toBe(0);
  });

  it("does not write into the image it was handed", async () => {
    const before = Uint8Array.from(image.data);

    await redact(call({}));

    expect(Buffer.from(image.data).equals(Buffer.from(before))).toBe(true);
  });

  // The photograph that hid three faces changed three ellipses: the matched
  // one is not one of them.
  it("leaves a matched face byte-identical and hides the other three", async () => {
    const result = await redact(
      call({ matches: [matchOf(smallestFace.id, 0.71)] })
    );
    const matched = crewRegions.indexOf(smallestFace);

    for (const [index, rect] of rects.entries()) {
      const changed = changedChannels(image, result.image, rect, () => true);
      if (index === matched) expect(changed).toBe(0);
      else expect(changed).toBeGreaterThan(0);
    }
  });

  // Mutation: any sigma that does not read this face's own width — a literal,
  // a module-level constant, the width of the call's first Region. All of them
  // give the two masks the same rise and the ratio falls to 1.
  //
  // The measurement, not a proxy for it: a mask laid over a step edge blurs
  // the step, and the width of what is left is 1.349 sigma. The photograph
  // cannot be used for this. Its four faces span 100 to 114 pixels, and
  // ADR-0008's plateau means every detail measure has already bottomed out at
  // both ends of that range, so the fixture is built rather than found.
  it("blurs with a sigma of a quarter of the face's own width", async () => {
    const edge = stepEdge();
    const row = STEP_EDGE_SIZE.height / 2;

    const riseOf = async (widthInPixels: number): Promise<number> => {
      const masked = await redact({
        image: edge,
        regions: [faceOnTheStep(widthInPixels)],
        matches: [],
        redaction: { blurUnknownFaces: true },
      });
      return riseAcross(masked.image, row);
    };

    const narrow = await riseOf(200);
    const wide = await riseOf(400);

    // Twice the face, twice the sigma.
    expect(wide / narrow).toBeCloseTo(2, 1);
    // And the quarter itself, not just the proportion. sharp's separable
    // approximation reads about 8 % under the nominal sigma at both widths,
    // which is why the band is 15 % rather than tighter.
    expect(sigmaBehind(narrow)).toBeGreaterThan(0.85 * 0.25 * 200);
    expect(sigmaBehind(narrow)).toBeLessThan(1.15 * 0.25 * 200);
    expect(sigmaBehind(wide)).toBeGreaterThan(0.85 * 0.25 * 400);
    expect(sigmaBehind(wide)).toBeLessThan(1.15 * 0.25 * 400);
  });

  // Mutation: hoist the sigma out of the loop. Then the three faces that are
  // not the first are masked with the first one's sigma in the four-face call
  // and with their own when they arrive alone, and the two runs part company.
  // Independence in its own right: four masks in one call are the same four
  // masks drawn one at a time, whatever order they arrive in.
  it("draws each mask from the untouched source, independent of the rest", async () => {
    expect(new Set(rects.map((rect) => rect.width)).size).toBe(rects.length);

    for (const [index, region] of crewRegions.entries()) {
      const alone = await redact(call({ regions: [region] }));
      const rect = rects[index]!;

      expect(changedChannels(masked, alone.image, rect, () => true)).toBe(0);
    }
  });

  // Mutation: take the width from `round(box.width x 1280)` instead of from
  // the two rounded edges. The sweep is deliberately two pixels wider than the
  // rectangle it defends: bounded by the rectangle itself the check could not
  // see a mask that ran past it, and would pass whatever the module did.
  //
  // The rule is not vacuous on this fixture. `round(width x 1280)` is 101 for
  // face-1 against the 100 pixels between its rounded edges, and
  // `round(height x 1600)` is 133 for face-2 against 134.
  it("keeps every changed pixel inside the Region's rounded rectangle", () => {
    expect(rects.map((rect) => `${rect.width}x${rect.height}`)).toEqual([
      "100x137",
      "111x134",
      "110x141",
      "114x145",
    ]);

    for (const rect of rects) {
      const changed = changedBounds(image, masked, grownBy(rect, 2, image));

      expect(changed).toBeDefined();
      expect(changed!.left).toBeGreaterThanOrEqual(rect.left);
      expect(changed!.top).toBeGreaterThanOrEqual(rect.top);
      expect(changed!.left + changed!.width).toBeLessThanOrEqual(
        rect.left + rect.width
      );
      expect(changed!.top + changed!.height).toBeLessThanOrEqual(
        rect.top + rect.height
      );
    }
  });
});
