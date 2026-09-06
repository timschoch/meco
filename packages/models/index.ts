// Entry point: the client, and the only file another package imports from
// `models`. `models` deploys as its own container, so this file is the whole
// seam — it carries the wire and nothing that runs a Model. The rules
// `services-do-not-import-each-other` and `models-client-stays-thin` in
// `.dependency-cruiser.cjs` hold both halves of that.
export {
  createModelsClient,
  ModelsError,
  type FetchLike,
  type ModelsClient,
  type ModelsClientOptions,
  type ModelsErrorCode,
} from "./lib/client";
export {
  AnnotateOptions,
  CatalogueEntry,
  ModelsHealth,
  WireError,
} from "./lib/wire";
// The size EdgeFace saw. identify judges its Identifiable Face floor in those
// pixels rather than the photograph's, and keeps no copy of the number.
export { DECODE_BOUND } from "./lib/decode-bound";
