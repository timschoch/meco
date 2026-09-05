import type { RenderInput } from "../index";
import { centredWindow, decode, KART_FIXTURE } from "./fixture";
import { PLACEMENTS } from "../placements";

/** One golden: a Template at a Placement, with the Fields and the photograph it is rendered from. */
export interface GoldenCase {
  readonly template: string;
  readonly placement: string;
  readonly brand: string;
  readonly fixture: string;
  readonly fields: Record<string, unknown>;
  /** The file under `tests/goldens/`. PNG, so the comparison is not reading JPEG noise. */
  readonly golden: string;
}

export const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    template: "swisshutless-story",
    placement: "instagram/story",
    brand: "swisshutless",
    fixture: KART_FIXTURE,
    fields: {
      headline: "Wohlen",
      kicker: "Nächstes Rennen",
      subline: "Wohlen, Schweiz",
      footnote: "12. – 14. Juni 2026",
    },
    golden: "swisshutless-story--instagram-story.png",
  },
];

/** The story every test starts from, so one edit moves the golden and the tests together. */
export const STORY_CASE = GOLDEN_CASES[0]!;

/**
 * The exact `render` call a golden case stands for, with anything a test wants
 * to vary laid over the top.
 *
 * The window is the tallest centred one of the Placement's own aspect. That
 * holds only while a Template's Image Slot fills the canvas; the first Template
 * whose slot is a column (#117) takes its aspect from the Plan instead.
 */
export async function inputFor(
  test: GoldenCase,
  overrides: Partial<RenderInput> = {}
): Promise<RenderInput> {
  const source = await decode(test.fixture);
  const placement = PLACEMENTS.find((p) => p.id === test.placement);
  if (!placement) throw new Error(`Unknown Placement ${test.placement}.`);
  return {
    template: test.template,
    placement: test.placement,
    brand: test.brand,
    fields: test.fields,
    source,
    window: centredWindow(source, placement),
    ...overrides,
  };
}
