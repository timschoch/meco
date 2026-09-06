import { templates, type PlanInput, type RenderInput } from "../index";
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
 * A Template's own `example` Fields, off the catalogue.
 *
 * Read rather than copied, because the catalogue is what a caller fills a
 * Template from: a golden rendered from a second, hand-kept set of Fields would
 * be a picture no caller can reproduce, and it would go on matching after the
 * `example` moved.
 */
export function exampleFields(template: string): Record<string, unknown> {
  const described = templates().find((t) => t.id === template);
  if (!described) throw new Error(`${template} is not in the catalogue.`);
  return described.example as Record<string, unknown>;
}

/**
 * One golden per Placement a Template declares, taken from `SHIPPED` so the
 * goldens cannot list a Placement the Template does not draw for, or miss one
 * it does.
 */
function goldensFor(
  template: string,
  brand: string,
  fixture: string,
  only?: readonly string[]
): GoldenCase[] {
  const shipped = SHIPPED.find((t) => t.id === template);
  if (!shipped) throw new Error(`${template} is not in SHIPPED.`);
  const fields = exampleFields(template);
  return (only ?? shipped.placements).map((placement) => ({
    template,
    placement,
    brand,
    fixture,
    fields,
    golden: `${template}--${placement.replace("/", "-")}.png`,
  }));
}

export const GOLDEN_CASES: readonly GoldenCase[] = [
  // Swiss Hutless has one golden and two Placements: `facebook/story` is
  // 1080x1920 like `instagram/story`, so it renders the same bytes. Hope Family
  // takes one per Placement, per #116, which is what makes a Template that ever
  // varies by Placement id visible here.
  ...goldensFor("swisshutless-story", "swisshutless", KART_FIXTURE, [
    "instagram/story",
  ]),
  ...goldensFor("hopefamily-story", "hopefamily", FACE_FIXTURE),
  ...goldensFor("hopefamily-post", "hopefamily", FACE_FIXTURE),
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
