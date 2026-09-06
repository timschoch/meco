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

/** Under `caption-top` the same block sits at the top of the padded canvas and grows downwards. */
const blockAtTop = (height: number) => ({
  x: PAD,
  y: PAD,
  width: SLOT.width - 2 * PAD,
  height,
});

/** The clear half of the frame each Variant declares as its Subject Area. */
const ABOVE_THE_BLOCK = { x: 0.1, y: 0.08, width: 0.8, height: 0.42 };
const BELOW_THE_BLOCK = { x: 0.1, y: 0.5, width: 0.8, height: 0.42 };

/** The one Plan of a Template that plans one way; the count is asserted where it matters. */
const only = (plans: readonly Plan[]): Plan => {
  if (plans.length !== 1) throw new Error(`${plans.length} Plans, wanted 1.`);
  return plans[0]!;
};

describe("plan", () => {
  it("gives one Plan per Variant, in the Template's order, the text block as one zone in each", async () => {
    const [bottom, top, ...rest] = await plan(planFor(STORY_CASE));

    expect(rest).toEqual([]);
    expect(bottom?.variant).toBe("caption-bottom");
    expect(top?.variant).toBe("caption-top");
    // The same Image Slot and the same block; only where the block sits moves.
    expect(bottom?.imageSlot).toEqual(SLOT);
    expect(top?.imageSlot).toEqual(SLOT);
    expect(inPixels(bottom!)).toEqual([blockAt(ONE_LINE_HEIGHT)]);
    expect(inPixels(top!)).toEqual([blockAtTop(ONE_LINE_HEIGHT)]);
  });

  it("gives each Variant the Subject Area it declares", async () => {
    const [bottom, top] = await plan(planFor(STORY_CASE));

    expect(bottom?.subjectArea).toEqual(ABOVE_THE_BLOCK);
    expect(top?.subjectArea).toEqual(BELOW_THE_BLOCK);
  });

  it("gives a taller Occlusion Zone for a headline that wraps onto a second line", async () => {
    const [short] = await plan(planFor(STORY_CASE));
    const [tall, tallTop] = await plan(
      planFor(STORY_CASE, {
        fields: { ...STORY_CASE.fields, headline: LONG_HEADLINE },
      })
    );

    // Both heights named, because the point of measuring the layout instead of
    // tabulating it is that this pair of numbers differs.
    expect(inPixels(short!)).toEqual([blockAt(ONE_LINE_HEIGHT)]);
    expect(inPixels(tall!)).toEqual([blockAt(TWO_LINE_HEIGHT)]);
    expect(inPixels(tallTop!)).toEqual([blockAtTop(TWO_LINE_HEIGHT)]);
  });

  it("plans a story given only the two Fields its schema requires", async () => {
    // #244: `subline` and `footnote` are optional, and leaving them out used
    // to be a throw from the layout walk rather than a shorter block. The
    // block loses the subline's line and keeps the footnote row, which still
    // holds the wordmark.
    const [bottom] = await plan(
      planFor(STORY_CASE, {
        fields: { headline: "Kart 24", kicker: "Startaufstellung" },
      })
    );
    const [zone] = inPixels(bottom!);

    expect(zone?.height).toBeLessThan(ONE_LINE_HEIGHT);
    expect(zone?.y).toBe(SLOT.height - PAD - zone!.height);
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
  const STORY_SLOT = { width: 1080, height: 1920 };
  const WORDMARK_ABOVE = { x: 84, y: 84, width: 300, height: 169 };
  const TYPE_BELOW = { x: 84, y: 1415, width: 912, height: 421 };
  // The other Variant: the same two boxes swapped end for end, each still its
  // padding from the edge it now sits at.
  const TYPE_ABOVE = { x: 84, y: 84, width: 912, height: 421 };
  const WORDMARK_BELOW = { x: 84, y: 1920 - 84 - 169, width: 300, height: 169 };

  const cases = [
    {
      template: "hopefamily-story",
      placement: "instagram/story",
      variant: "caption-bottom",
      slot: STORY_SLOT,
      zones: [WORDMARK_ABOVE, TYPE_BELOW],
      subject: { x: 0.08, y: 0.18, width: 0.84, height: 0.44 },
    },
    {
      template: "hopefamily-story",
      placement: "instagram/story",
      variant: "caption-top",
      slot: STORY_SLOT,
      zones: [TYPE_ABOVE, WORDMARK_BELOW],
      subject: { x: 0.08, y: 0.38, width: 0.84, height: 0.44 },
    },
    {
      template: "hopefamily-story",
      placement: "facebook/story",
      variant: "caption-bottom",
      slot: STORY_SLOT,
      zones: [WORDMARK_ABOVE, TYPE_BELOW],
      subject: { x: 0.08, y: 0.18, width: 0.84, height: 0.44 },
    },
    {
      template: "hopefamily-story",
      placement: "facebook/story",
      variant: "caption-top",
      slot: STORY_SLOT,
      zones: [TYPE_ABOVE, WORDMARK_BELOW],
      subject: { x: 0.08, y: 0.38, width: 0.84, height: 0.44 },
    },
    {
      template: "hopefamily-post",
      placement: "instagram/post",
      variant: undefined,
      slot: { width: 1080, height: 1350 },
      zones: [
        { x: 76, y: 76, width: 280, height: 157 },
        { x: 76, y: 904, width: 928, height: 370 },
      ],
      subject: { x: 0.08, y: 0.2, width: 0.84, height: 0.34 },
    },
    {
      // The one that earns the second Template: wider than it is tall, so the
      // type is a 58 % column on the left and the Subject Area is the right.
      template: "hopefamily-post",
      placement: "facebook/post",
      variant: undefined,
      slot: { width: 1200, height: 630 },
      zones: [
        { x: 56, y: 56, width: 220, height: 124 },
        { x: 56, y: 268, width: 584, height: 306 },
      ],
      subject: { x: 0.62, y: 0.08, width: 0.32, height: 0.84 },
    },
  ];

  it.each(cases)(
    "$template at $placement ($variant) covers the wordmark and the type block and leaves the Subject Area clear",
    async ({ template, placement, variant, slot, zones, subject }) => {
      const plans = await plan({
        template,
        placement,
        brand: "hopefamily",
        fields: exampleFields(template),
      });
      const result = plans.find((one) => one.variant === variant);

      expect(result?.imageSlot).toEqual(slot);
      expect(inPixels(result!, slot)).toEqual(zones);
      expect(result?.subjectArea).toEqual(subject);
    }
  );

  it("plans hopefamily-post one way and hopefamily-story two", async () => {
    const post = await plan({
      template: "hopefamily-post",
      placement: "instagram/post",
      brand: "hopefamily",
      fields: exampleFields("hopefamily-post"),
    });
    const story = await plan({
      template: "hopefamily-story",
      placement: "instagram/story",
      brand: "hopefamily",
      fields: exampleFields("hopefamily-story"),
    });

    expect("variant" in only(post)).toBe(false);
    expect(story.map((one) => one.variant)).toEqual([
      "caption-bottom",
      "caption-top",
    ]);
  });
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
    const result = only(await plan(planFor(LAICA_AT_WIDE)));

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
    const result = only(await plan(planFor(LAICA_AT_POST)));

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
    const [zone] = only(await plan(planFor(LAICA_AT_POST))).occlusion;

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
    // Closed, so a caller can branch on the code exhaustively. Four of the
    // seven are exercised below; `unknown_variant` and `framing_mismatch` need
    // a `render`, where `tests/render.test.ts` covers them, and
    // `look_assets_missing` needs a Look's file to go missing, which
    // `tests/assets.test.ts` arranges.
    expect(COMPOSE_ERROR_CODES).toEqual([
      "unknown_template",
      "unknown_brand",
      "placement_not_supported",
      "invalid_fields",
      "unknown_variant",
      "framing_mismatch",
      "look_assets_missing",
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
