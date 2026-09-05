// Entry point. Everything under `lib/` is private to this package.
//
// compose lays a Template over a picture and produces the finished Render. It
// is the last stage that touches pixels and the only one that encodes. It
// fetches nothing, stores nothing, and chooses no crop.
export { render } from "./lib/render";
export type { RenderFormat, RenderInput, RenderResult } from "./lib/render";
export { ComposeError, COMPOSE_ERROR_CODES } from "./lib/errors";
export type { ComposeErrorCode } from "./lib/errors";
export type { DecodedImage } from "./lib/decoded-image";
export {
  PLACEMENTS,
  PLACEMENT_IDS,
  placement,
  type Placement,
  type PlacementId,
} from "./placements";
