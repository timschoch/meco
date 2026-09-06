import type { PlanInput, RenderInput } from "../index";
import { centredWindow, decode, FACE_FIXTURE, KART_FIXTURE } from "./fixture";
import { PLACEMENTS } from "../placements";

/**
 * Every Template that ships, with the Placements it declares, in registry
 * order. One list, so a Template added without its catalogue entry, its layout
 * Checks or its goldens shows up as a count that no longer matches.
 */
export const SHIPPED: readonly {
  readonly id: string;
  readonly placements: readonly string[];
}[] = [
  {
    id: "swisshutless-story",
    placements: ["instagram/story", "facebook/story"],
  },
  { id: "hopefamily-story", placements: ["instagram/story", "facebook/story"] },
  { id: "hopefamily-post", placements: ["instagram/post", "facebook/post"] },
];

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

/**
 * The Fields both Hope Family Templates are rendered from. One set, because the
 * two Templates carry the same blog post at two shapes and a golden pair is only
 * worth comparing by eye when nothing but the shape differs.
 */
export const HOPE_FIELDS = {
  title: "Vier Wochen Vanlife durch Norwegen",
  kicker: "Neuer Blogpost",
  excerpt:
    "Fjorde, Regen und ein Kocher, der nie funktioniert hat — was wir unterwegs gelernt haben.",
  date: "6. September 2026",
};

/** A Hope Family Template's golden at each Placement it declares. */
function hopeFamily(
  template: string,
  placements: readonly string[]
): GoldenCase[] {
  return placements.map((placement) => ({
    template,
    placement,
    brand: "hopefamily",
    fixture: FACE_FIXTURE,
    fields: HOPE_FIELDS,
    golden: `${template}--${placement.replace("/", "-")}.png`,
  }));
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
  ...hopeFamily("hopefamily-story", ["instagram/story", "facebook/story"]),
  ...hopeFamily("hopefamily-post", ["instagram/post", "facebook/post"]),
];

/** The story every test starts from, so one edit moves the golden and the tests together. */
export const STORY_CASE = GOLDEN_CASES[0]!;

/**
 * The `plan` half of a golden case: the same Template, Placement, Brand and
 * Fields the picture is rendered from, so a Plan test and a golden cannot drift
 * apart. Synchronous, because a Plan needs no picture.
 */
export function planFor(
  test: GoldenCase,
  overrides: Partial<PlanInput> = {}
): PlanInput {
  return {
    template: test.template,
    placement: test.placement,
    brand: test.brand,
    fields: test.fields,
    ...overrides,
  };
}

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
    ...planFor(test),
    source,
    window: centredWindow(source, placement),
    ...overrides,
  };
}
