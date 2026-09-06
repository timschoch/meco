import { describe, expect, it } from "vitest";
import { layoutConformance, type LayoutFixtures } from "../conformance";
import type { Template } from "../template";
import { SHIPPED } from "./cases";
import { decode, KART_FIXTURE } from "./fixture";
import { CROSSING_SLOT, OUTSIDE_SLOT } from "./foreign-templates";

/**
 * The two pictures the Plan must be identical for, beside the no-bytes case the
 * checks measure themselves: a flat 9x16 placeholder and a real photograph of a
 * different shape. Both are resampled into the Image Slot before the layout
 * pass, so what varies between them is the content, which is the whole point.
 */
const fixtures: LayoutFixtures = {
  images: [
    {
      width: 900,
      height: 1600,
      channels: 3,
      data: new Uint8Array(900 * 1600 * 3).fill(128),
    },
    await decode(KART_FIXTURE),
  ],
};

/** The rules of `docs/specs/compose.md`, in the order they run. */
const RULES = [
  "places exactly one Image Slot",
  "keeps every Occlusion Zone inside the Image Slot",
  "needs no Occlusion Zone clipped",
  "drops any Occlusion Zone wholly outside the Image Slot",
  "keeps every text run inside its own box",
  "plans the same whatever the image bytes are",
  "declares a valid Subject Area or none",
  "keeps the Subject Area clear of every Occlusion Zone",
  "declares no more Occlusion Zones than a FramingRequest holds",
];

const checks = layoutConformance(fixtures);

/** Every Check for one Template a caller registered, by the rule it stands for. */
async function verdicts(template: Template): Promise<Record<string, string>> {
  const entries = await Promise.all(
    layoutConformance({ ...fixtures, templates: [template] }).map(
      async (check) => {
        const rule = check.name.slice(
          `${template.id} at ${template.placements[0]} `.length
        );
        try {
          await check.run();
          return [rule, "passes"] as const;
        } catch (error) {
          return [rule, (error as Error).message] as const;
        }
      }
    )
  );
  return Object.fromEntries(entries);
}

describe("the layout suite", () => {
  it("covers every Template at every Placement it declares", () => {
    // One entry per Template x declared Placement x rule, driven off the list of
    // what ships, so a Template added without its checks running shows up here
    // as a wrong count.
    const expected = SHIPPED.flatMap((template) =>
      template.placements.flatMap((placement) =>
        (template.variants ?? [undefined]).flatMap((variant) =>
          RULES.map(
            (rule) =>
              `${template.id} at ${placement}${variant === undefined ? "" : ` (${variant})`} ${rule}`
          )
        )
      )
    );

    expect(checks.length).toBe(expected.length);
    expect(checks.map((check) => check.name)).toEqual(expected);
  });

  it.each(checks)("$name", async (check) => {
    await check.run();
  });
});

describe("a Template a caller registered", () => {
  it("passes every rule with an Occlusion Zone wholly outside the Image Slot", async () => {
    // The zone is off the slot, so the Plan drops it rather than reporting a
    // rectangle of no area. Nothing about that is a design fault, which is why
    // it is a rule of its own and not the clipping rule.
    const ruled = await verdicts(OUTSIDE_SLOT);

    expect(Object.keys(ruled)).toEqual(RULES);
    expect(Object.values(ruled).filter((v) => v !== "passes")).toEqual([]);
  });

  it("fails only the clipping rule with an Occlusion Zone across the edge", async () => {
    // The same frame with the same two zones, the second moved up so it lies
    // half on the slot and half off. That one the Plan clips, and a design
    // whose overlay is cut in half never renders whole.
    const ruled = await verdicts(CROSSING_SLOT);

    expect(ruled["needs no Occlusion Zone clipped"]).toMatch(
      /1 Occlusion Zone\(s\) leave the 1080x960 Image Slot/
    );
    expect(
      Object.entries(ruled).filter(
        ([rule, verdict]) =>
          verdict !== "passes" && rule !== "needs no Occlusion Zone clipped"
      )
    ).toEqual([]);
  });
});
