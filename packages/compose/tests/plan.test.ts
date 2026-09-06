import { describe, expect, it } from "vitest";
import { COMPOSE_ERROR_CODES, ComposeError, plan, type Plan } from "../index";
import {
  exampleFields,
  LAICA_AT_POST,
  LAICA_AT_WIDE,
  planFor,
  STORY_CASE,
} from "./cases";

const SLOT = { width: 1080, height: 1920 };

/**
 * A zone back in whole Image Slot pixels, which is where its numbers came from
 * and the only scale a reader can check by hand against the Template.
 *
 * Scaled by the Plan's own `imageSlot`, not by the Placement: `laica-post`'s
 * slot is a column, so the two are different numbers and only the slot's is the
 * one the fractions were divided by.
 *
 * Rounded, because a fraction is a measured pixel count divided by the slot and
 * the divide leaves float noise: the example's block is 896.0000000000001 px
 * wide. Nothing is hidden by it — a layout that moved is at least a pixel out,
 * and that is a different integer.
 */
const inPixels = (plan: Plan, slot: { width: number; height: number } = SLOT) =>
  plan.occlusion.map((zone) => ({
    x: Math.round(zone.x * slot.width),
    y: Math.round(zone.y * slot.height),
    width: Math.round(zone.width * slot.width),
    height: Math.round(zone.height * slot.height),
  }));

/** The Template's own padding, so three of the block's four edges are arithmetic. */
const PAD = 92;

/**
 * The text block on one line and on two, measured on takumi 2.13.6 with Barlow
 * at the sizes `swisshutless-story.tsx` names. 114 px apart, which is the
 * headline's 112 px at its 1.02 leading: one more line of the loud type and
 * nothing else.
 */
const ONE_LINE_HEIGHT = 391;
const TWO_LINE_HEIGHT = 505;

/** A headline that does not fit on one line at 112 px in an 896 px box. */
const LONG_HEADLINE = "Grosser Preis von Wohlen im Freiamt";

/** The block sits at the bottom of the padded canvas and grows upwards. */
const blockAt = (height: number) => ({
  x: PAD,
  y: SLOT.height - PAD - height,
  width: SLOT.width - 2 * PAD,
  height,
});

describe("plan", () => {
  it("gives the Image Slot in pixels, the text block as one zone and the declared Subject Area", async () => {
    const result = await plan(planFor(STORY_CASE));

    expect(result.imageSlot).toEqual(SLOT);
    expect(inPixels(result)).toEqual([blockAt(ONE_LINE_HEIGHT)]);
    expect(result.subjectArea).toEqual({
      x: 0.1,
      y: 0.08,
      width: 0.8,
      height: 0.42,
    });
  });

  it("gives a taller Occlusion Zone for a headline that wraps onto a second line", async () => {
    const short = await plan(planFor(STORY_CASE));
    const tall = await plan(
      planFor(STORY_CASE, {
        fields: { ...STORY_CASE.fields, headline: LONG_HEADLINE },
      })
    );

    // Both heights named, because the point of measuring the layout instead of
    // tabulating it is that this pair of numbers differs.
    expect(inPixels(short)).toEqual([blockAt(ONE_LINE_HEIGHT)]);
    expect(inPixels(tall)).toEqual([blockAt(TWO_LINE_HEIGHT)]);
  });

  it("stays the same call after call", async () => {
    const first = await plan(planFor(STORY_CASE));
    const second = await plan(planFor(STORY_CASE));

    expect(second).toEqual(first);
  });
});

/**
 * The Hope Family Templates put two things over the picture, not one, and the
 * Subject Area has to sit in the gap between them. These are the measured
 * numbers on takumi 2.13.6 with Eina 02 at the sizes the two modules name, in
 * whole Image Slot pixels, so a reader can check every edge against the
 * Template by hand: three of the wordmark's four and three of the type block's
 * are its padding, and the fourth is what the type measured.
 */
describe("plan for the Hope Family Templates", () => {
  const cases = [
    {
      template: "hopefamily-story",
      placement: "instagram/story",
      slot: { width: 1080, height: 1920 },
      wordmark: { x: 84, y: 84, width: 300, height: 169 },
      typeBlock: { x: 84, y: 1415, width: 912, height: 421 },
      subject: { x: 0.08, y: 0.18, width: 0.84, height: 0.44 },
    },
    {
      template: "hopefamily-story",
      placement: "facebook/story",
      slot: { width: 1080, height: 1920 },
      wordmark: { x: 84, y: 84, width: 300, height: 169 },
      typeBlock: { x: 84, y: 1415, width: 912, height: 421 },
      subject: { x: 0.08, y: 0.18, width: 0.84, height: 0.44 },
    },
    {
      template: "hopefamily-post",
      placement: "instagram/post",
      slot: { width: 1080, height: 1350 },
      wordmark: { x: 76, y: 76, width: 280, height: 157 },
      typeBlock: { x: 76, y: 904, width: 928, height: 370 },
      subject: { x: 0.08, y: 0.2, width: 0.84, height: 0.34 },
    },
    {
      // The one that earns the second Template: wider than it is tall, so the
      // type is a 58 % column on the left and the Subject Area is the right.
      template: "hopefamily-post",
      placement: "facebook/post",
      slot: { width: 1200, height: 630 },
      wordmark: { x: 56, y: 56, width: 220, height: 124 },
      typeBlock: { x: 56, y: 268, width: 584, height: 306 },
      subject: { x: 0.62, y: 0.08, width: 0.32, height: 0.84 },
    },
  ];

  it.each(cases)(
    "$template at $placement covers the wordmark and the type block and leaves the Subject Area clear",
    async ({ template, placement, slot, wordmark, typeBlock, subject }) => {
      const result = await plan({
        template,
        placement,
        brand: "hopefamily",
        fields: exampleFields(template),
      });

      expect(result.imageSlot).toEqual(slot);
      expect(inPixels(result, slot)).toEqual([wordmark, typeBlock]);
      expect(result.subjectArea).toEqual(subject);
    }
  );
});

/**
 * `laica-post`'s Image Slot is a column, so its geometry, measured on takumi
 * 2.13.6 with Outfit at the sizes the Template names:
 *
 * - `linkedin/wide` 1200x627: the picture takes 42 % of the width, 504x627, and
 *   the type sits beside it, so nothing covers the picture.
 * - `linkedin/post` 1200x1200: the picture is a plate 42 % of the height deep,
 *   inset by the page's 88 px margin, so the slot is 1024x504 and starts at
 *   (88, 88) rather than the canvas corner. The chip sits 48 px in from the
 *   plate's own left and bottom edges. Three of the chip's four numbers are
 *   that inset and the slot's height; the fourth, 234 px, is the width
 *   "LOGBUCH" measures at Outfit 500 — the Look's second instance of one
 *   variable file, and 2 px wider than the same label at 400.
 */
const SLOT_AT_WIDE = { width: 504, height: 627 };
const SLOT_AT_POST = { width: 1024, height: 504 };
const CHIP_INSET = 48;
const CHIP = { width: 234, height: 62 };

describe("plan for a Template whose Image Slot is a column", () => {
  it("gives the column's own size at linkedin/wide, and no Occlusion Zone", async () => {
    const result = await plan(planFor(LAICA_AT_WIDE));

    // Not 1200x627. This is the number the gateway hands frame as `target`.
    expect(result.imageSlot).toEqual(SLOT_AT_WIDE);
    expect(result.occlusion).toEqual([]);
    expect(result.subjectArea).toEqual({
      x: 0.12,
      y: 0.08,
      width: 0.76,
      height: 0.5,
    });
  });

  it("gives the inset plate at linkedin/post, with the chip as one zone", async () => {
    const result = await plan(planFor(LAICA_AT_POST));

    expect(result.imageSlot).toEqual(SLOT_AT_POST);
    expect(inPixels(result, SLOT_AT_POST)).toEqual([
      {
        x: CHIP_INSET,
        y: SLOT_AT_POST.height - CHIP_INSET - CHIP.height,
        ...CHIP,
      },
    ]);
    expect(result.subjectArea).toEqual({
      x: 0.34,
      y: 0.08,
      width: 0.42,
      height: 0.84,
    });
  });

  it("measures the zone against the Image Slot, not the canvas", async () => {
    const [zone] = (await plan(planFor(LAICA_AT_POST))).occlusion;

    // The two regressions the pixel assertion above cannot catch on its own,
    // named as fractions because that is the form frame receives. Divide by the
    // Placement's 1200 rather than the slot's 504 and the chip lands at y 0.328;
    // forget to subtract the slot's own (88, 88) origin and it lands at 0.957.
    // Both are still a valid Box and still one zone.
    expect(zone?.y).toBeCloseTo(394 / SLOT_AT_POST.height, 6);
    expect(zone?.x).toBeCloseTo(CHIP_INSET / SLOT_AT_POST.width, 6);
    expect(zone?.height).toBeCloseTo(CHIP.height / SLOT_AT_POST.height, 6);
  });
});

describe("plan refusals", () => {
  it("has one code per way compose refuses, and no more", () => {
    // Closed, so a caller can branch on the code exhaustively. Four of the five
    // are exercised below; `framing_mismatch` needs a window and so belongs to
    // `render`, where `tests/render.test.ts` covers it.
    expect(COMPOSE_ERROR_CODES).toEqual([
      "unknown_template",
      "unknown_brand",
      "placement_not_supported",
      "invalid_fields",
      "framing_mismatch",
    ]);
  });

  it.each([
    [{ template: "no-such-template" }, "unknown_template"],
    [{ brand: "no-such-brand" }, "unknown_brand"],
    [{ placement: "linkedin/wide" }, "placement_not_supported"],
    [{ placement: "no-such-placement" }, "placement_not_supported"],
    [{ fields: { kicker: "only a kicker" } }, "invalid_fields"],
  ])("refuses %o with %s", async (overrides, code) => {
    const call = plan(planFor(STORY_CASE, overrides));

    await expect(call).rejects.toBeInstanceOf(ComposeError);
    await expect(call).rejects.toThrow(expect.objectContaining({ code }));
  });
});
