import { describe, expect, it } from "vitest";
import { ComposeError, plan, type Plan } from "../index";
import { planFor, STORY_CASE } from "./cases";

const SLOT = { width: 1080, height: 1920 };

/**
 * A zone back in whole Image Slot pixels, which is where its numbers came from
 * and the only scale a reader can check by hand against the Template.
 *
 * Rounded, because a fraction is a measured pixel count divided by the slot and
 * the divide leaves float noise: the example's block is 896.0000000000001 px
 * wide. Nothing is hidden by it — a layout that moved is at least a pixel out,
 * and that is a different integer.
 */
const inPixels = (plan: Plan) =>
  plan.occlusion.map((zone) => ({
    x: Math.round(zone.x * SLOT.width),
    y: Math.round(zone.y * SLOT.height),
    width: Math.round(zone.width * SLOT.width),
    height: Math.round(zone.height * SLOT.height),
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

describe("plan refusals", () => {
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
