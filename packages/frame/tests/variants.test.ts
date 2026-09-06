import { describe, expect, it } from "vitest";
import type { Box, Size } from "@meco/contracts";
import { frameCrop, frameVariants, type VariantRequest } from "../index";
import { emptyAnnotation, requestFor, vehicleAnnotation } from "./samples";

/** `kart` alone: no landmarks, no Eye Line, so the aim is all that moves. */
const KART_ONLY = { pinTo: ["kart"] };

const STORY: Size = { width: 1080, height: 1920 };

/**
 * `swisshutless-story`'s two layouts as `compose.plan` measures them for the
 * example Fields (`packages/compose/tests/plan.test.ts`): a 896x391 block of
 * type inset 92 px, at the bottom of the canvas or at the top, in Image Slot
 * fractions, each with the Subject Area its Variant declares.
 */
const BLOCK = { x: 92 / 1080, width: 896 / 1080, height: 391 / 1920 };
const CAPTION_BOTTOM = {
  variant: "caption-bottom",
  occlusion: [{ ...BLOCK, y: (1920 - 92 - 391) / 1920 }],
  subjectArea: { x: 0.1, y: 0.08, width: 0.8, height: 0.42 },
};
const CAPTION_TOP = {
  variant: "caption-top",
  occlusion: [{ ...BLOCK, y: 92 / 1920 }],
  subjectArea: { x: 0.1, y: 0.5, width: 0.8, height: 0.42 },
};

const variantsOf = (
  layouts: readonly (typeof CAPTION_BOTTOM)[],
  target: Size = STORY
): VariantRequest[] =>
  layouts.map(({ variant, occlusion, subjectArea }) => ({
    variant,
    request: requestFor(target, { ...KART_ONLY, occlusion, subjectArea }),
  }));

/**
 * The defect, as production measured it (#228, Call `e0466f34`): the owner's
 * race photograph, 800x533, whose composed kart Subject sits in the bottom
 * third. Not a recording — the photograph is third-party — but its numbers:
 * the Subject is the one frame composed on that Call, copied off the Framing.
 */
const RACE: Size = { width: 800, height: 533 };
const FRONT_KARTS: Box = {
  x: 0.404794,
  y: 0.593631,
  width: 0.513577,
  height: 0.309864,
};

describe("the race photograph into a story", () => {
  const framing = frameVariants({
    annotation: vehicleAnnotation(RACE, FRONT_KARTS),
    variants: variantsOf([CAPTION_BOTTOM, CAPTION_TOP]),
  });

  it("is a full-height column the caption cannot be aimed away from", () => {
    // 533 tall, 300 wide: the window touches the top and the bottom, so no
    // aim moves the Subject up the frame and out from under a bottom caption.
    expect(framing.window).toMatchObject({ y: 0, width: 300, height: 533 });
  });

  it("picks caption-top, which keeps the front karts clear of the type", () => {
    expect(framing.variant).toBe("caption-top");
    expect(framing.occlusionClear).toBe(true);
    // The same photograph framed on the bottom caption alone is the
    // production answer: the Subject under the block.
    expect(
      frameCrop({
        annotation: vehicleAnnotation(RACE, FRONT_KARTS),
        request: variantsOf([CAPTION_BOTTOM])[0]!.request,
      }).occlusionClear
    ).toBe(false);
  });

  it("still clips, because no Variant widens a 300 px window round a 411 px Subject", () => {
    // What the ticket's acceptance asked for and no layout can give: the
    // kept Region is wider than the window on every Variant, so `satisfied`
    // ties at false and cannot be what chose the caption.
    expect(framing.satisfied).toBe(false);
    expect(framing.fallback).toBe("clip");
  });

  it("says it is an upscale: 300 px of picture for a 1080 px story", () => {
    // 1920 / 533 on the constrained axis; 1080 / 300 would read 3.600 and the
    // two differ by the rounding of 299.8 to 300.
    expect(framing.scale).toBeCloseTo(3.6, 2);
    expect(framing.lowResolution).toBe(true);
  });
});

describe("which Variant answers", () => {
  it("keeps the first Variant when two mirrored layouts tie to the last bit of a float", () => {
    // `hopefamily-story`'s two layouts as measured, on the dark-visor kart:
    // both clip, both put the Subject under a block, both leave a 0.84 x 0.44
    // Free Area — one as 0.62 - 0.18 and the other as 0.82 - 0.38, which are
    // not the same double. Measured on the gateway before the tolerance went
    // in: the second Variant won on nothing.
    const wordmark = { x: 84 / 1080, width: 300 / 1080, height: 169 / 1920 };
    const type = { x: 84 / 1080, width: 912 / 1080, height: 421 / 1920 };
    const mirrored = (
      variant: string,
      zones: Box[],
      subjectArea: Box
    ): VariantRequest => ({
      variant,
      request: requestFor(STORY, {
        ...KART_ONLY,
        occlusion: zones,
        subjectArea,
      }),
    });
    const framing = frameVariants({
      annotation: vehicleAnnotation(
        { width: 1600, height: 1000 },
        { x: 0.400791, y: 0.097297, width: 0.433666, height: 0.49558 }
      ),
      variants: [
        mirrored(
          "caption-bottom",
          [
            { ...wordmark, y: 84 / 1920 },
            { ...type, y: (1920 - 84 - 421) / 1920 },
          ],
          { x: 0.08, y: 0.18, width: 0.84, height: 0.44 }
        ),
        mirrored(
          "caption-top",
          [
            { ...type, y: 84 / 1920 },
            { ...wordmark, y: (1920 - 84 - 169) / 1920 },
          ],
          { x: 0.08, y: 0.38, width: 0.84, height: 0.44 }
        ),
      ],
    });

    expect(framing.occlusionClear).toBe(false);
    expect(framing.satisfied).toBe(false);
    expect(framing.variant).toBe("caption-bottom");
  });

  it("keeps the Template's first Variant when the Subject is clear of both", () => {
    // A kart in the middle of the frame is under neither caption, so nothing
    // separates the two and the preference decides.
    const framing = frameVariants({
      annotation: vehicleAnnotation(RACE, {
        x: 0.4,
        y: 0.35,
        width: 0.2,
        height: 0.25,
      }),
      variants: variantsOf([CAPTION_BOTTOM, CAPTION_TOP]),
    });

    expect(framing.variant).toBe("caption-bottom");
    expect(framing.occlusionClear).toBe(true);
  });

  it("keeps the first Variant when the Subject sits under the other's caption", () => {
    const framing = frameVariants({
      annotation: vehicleAnnotation(RACE, {
        x: 0.4,
        y: 0.05,
        width: 0.2,
        height: 0.25,
      }),
      variants: variantsOf([CAPTION_BOTTOM, CAPTION_TOP]),
    });

    expect(framing.variant).toBe("caption-bottom");
    expect(framing.occlusionClear).toBe(true);
  });

  it("prefers the Variant that leaves the larger Free Area, other things equal", () => {
    // A tall source with slack down the frame, so both bands are cleared and
    // both windows hold the Subject; the shorter band leaves more picture.
    const source: Size = { width: 1000, height: 3000 };
    const subject: Box = { x: 0.4, y: 0.45, width: 0.2, height: 0.05 };
    // No Subject Area: with one, the Free Area is the intersection and both
    // bands would leave the same one.
    const band = (variant: string, height: number): VariantRequest => ({
      variant,
      request: requestFor(STORY, {
        ...KART_ONLY,
        occlusion: [{ x: 0, y: 1 - height, width: 1, height }],
      }),
    });
    const framing = frameVariants({
      annotation: vehicleAnnotation(source, subject),
      variants: [band("tall-band", 0.3), band("short-band", 0.2)],
    });

    expect(framing.satisfied).toBe(true);
    expect(framing.occlusionClear).toBe(true);
    expect(framing.variant).toBe("short-band");
  });

  it("ranks a clear Subject above a satisfied window", () => {
    // Two kept Regions that no story column holds: the kart, and a second
    // vehicle off to the side. Both Variants sacrifice nothing and clip; what
    // differs is only which caption the kart lands under.
    const framing = frameVariants({
      annotation: vehicleAnnotation(RACE, FRONT_KARTS),
      variants: variantsOf([CAPTION_BOTTOM, CAPTION_TOP]),
    });
    const bottomAlone = frameCrop({
      annotation: vehicleAnnotation(RACE, FRONT_KARTS),
      request: variantsOf([CAPTION_BOTTOM])[0]!.request,
    });

    expect(bottomAlone.satisfied).toBe(framing.satisfied);
    expect(framing.variant).toBe("caption-top");
  });
});

describe("one Variant, and none", () => {
  const source: Size = { width: 1200, height: 800 };
  const square: Size = { width: 1080, height: 1080 };

  it("answers frameCrop's own Framing for one unnamed request, with no variant", () => {
    const request = requestFor(square, KART_ONLY);
    const chosen = frameVariants({
      annotation: vehicleAnnotation(source),
      variants: [{ request }],
    });

    expect(chosen).toEqual(
      frameCrop({ annotation: vehicleAnnotation(source), request })
    );
    expect("variant" in chosen).toBe(false);
  });

  it("names the one Variant a Template offers", () => {
    const request = requestFor(square, KART_ONLY);
    const chosen = frameVariants({
      annotation: vehicleAnnotation(source),
      variants: [{ variant: "only", request }],
    });

    expect(chosen.variant).toBe("only");
  });

  it("answers with the first Variant when nothing was composed at all", () => {
    // The centre composes no Subject, so no Variant is clearer than another;
    // the Template's preference is the whole answer.
    const chosen = frameVariants({
      annotation: emptyAnnotation(source),
      variants: variantsOf([CAPTION_BOTTOM, CAPTION_TOP], STORY),
    });

    expect(chosen.variant).toBe("caption-bottom");
    expect(chosen.resolvedBy).toBe("center");
  });

  it("refuses an empty list, which has nothing to answer with", () => {
    expect(() =>
      frameVariants({ annotation: emptyAnnotation(source), variants: [] })
    ).toThrow(RangeError);
  });
});

describe("scale", () => {
  it("is below one, with no lowResolution flag, when the picture is bigger than the target", () => {
    const framing = frameCrop({
      annotation: emptyAnnotation({ width: 4000, height: 3000 }),
      request: requestFor({ width: 1080, height: 1080 }),
    });

    expect(framing.window).toMatchObject({ width: 3000, height: 3000 });
    expect(framing.scale).toBeCloseTo(0.36, 6);
    expect("lowResolution" in framing).toBe(false);
  });

  it("is the target over the window on the constrained axis, past one on a small picture", () => {
    const framing = frameCrop({
      annotation: emptyAnnotation({ width: 512, height: 512 }),
      request: requestFor({ width: 1080, height: 1920 }),
    });

    // 512 tall gives a 288x512 column; 1920 / 512 = 3.75 = 1080 / 288.
    expect(framing.window).toMatchObject({ width: 288, height: 512 });
    expect(framing.scale).toBeCloseTo(3.75, 6);
    expect(framing.lowResolution).toBe(true);
  });
});
