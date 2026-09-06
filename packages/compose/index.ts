// Entry point. Everything under `lib/` is private to this package.
//
// compose lays a Template over a picture and produces the finished Render. It
// is the last stage that touches pixels and the only one that encodes. It
// fetches nothing, stores nothing, and chooses no crop.
export { plan } from "./lib/plan";
export type { Plan, PlanInput } from "./lib/plan";
export { render, cut } from "./lib/render";
export type {
  CutInput,
  RenderFormat,
  RenderInput,
  RenderResult,
} from "./lib/render";
export { templates } from "./lib/templates/catalogue";
export type { TemplateDescription } from "./lib/templates/catalogue";
export { ComposeError, COMPOSE_ERROR_CODES } from "./lib/errors";
export type { ComposeErrorCode } from "./lib/errors";
// Re-exported so a caller of `render` needs one import, not two. The type is
// contracts', not compose's: the models host decodes and everyone downstream
// agrees on the shape.
export type { DecodedImage } from "@meco/contracts";
// The catalogue, for a caller that already imports `index.ts`. Its own entry
// point, `./placements`, is the one the gateway reaches for.
export { PLACEMENTS, type Placement, type PlacementId } from "./placements";
