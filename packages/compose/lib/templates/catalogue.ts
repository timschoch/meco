import { z } from "zod";
import type { PlacementId } from "../../placements";
import type { Template } from "../../template";
import { TEMPLATES } from "./registry";

/**
 * One Template as a caller discovers it: enough to fill it unaided, and nothing
 * that only compose can use.
 *
 * `fields` is JSON Schema rather than the zod object, because the caller on the
 * other side of the gateway is an MCP client that speaks JSON Schema and does
 * not have zod. `example` is the Template's own, so what a caller copies is
 * what the golden image was rendered from.
 */
export interface TemplateDescription {
  readonly id: string;
  readonly brand: string;
  readonly description: string;
  readonly placements: readonly PlacementId[];
  /**
   * The Variants the Template offers, most preferred first, when it offers
   * any. A caller cannot ask for one — frame chooses — but can read which
   * names a Framing may come back with.
   */
  readonly variants?: readonly string[];
  /**
   * The Fields as JSON Schema, draft 2020-12.
   *
   * A plain object and not zod's own `JSONSchema` type: a description crosses
   * the gateway as JSON, and typing it to zod would make every reader of the
   * catalogue depend on compose's validator.
   */
  readonly fields: Record<string, unknown>;
  /** Real Fields that render. */
  readonly example: unknown;
}

const describeTemplate = (template: Template): TemplateDescription => ({
  id: template.id,
  brand: template.brand,
  description: template.description,
  placements: template.placements,
  ...(template.variants === undefined
    ? {}
    : { variants: template.variants.map((variant) => variant.name) }),
  fields: z.toJSONSchema(template.fields) as Record<string, unknown>,
  example: template.example,
});

/**
 * Every Template compose knows, or only one Brand's.
 *
 * Sorted by id, so a caller diffing two catalogues sees what changed and not
 * where a static import moved. A Brand with no Template yet lists nothing;
 * that is not a refusal, because asking what a Brand offers is a fair question
 * whatever the answer.
 */
export function templates(brand?: string): readonly TemplateDescription[] {
  return [...TEMPLATES.values()]
    .filter((template) => brand === undefined || template.brand === brand)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(describeTemplate);
}
