// Entry point: the Models Client, and the only file another package imports
// from `models`. It carries the wire and nothing that runs a Model; the rules
// `services-do-not-import-each-other` and `models-client-stays-thin` in
// `.dependency-cruiser.cjs` are what hold that.
export {
  createModelsClient,
  ModelsError,
  type Annotated,
  type AnnotateSource,
  type FetchLike,
  type ServerTimingEntry,
  type ModelsClient,
  type ModelsClientOptions,
  type ModelsErrorCode,
} from "./lib/client";
export { AnnotateOptions, CatalogueEntry, ModelsHealth } from "./lib/wire";
// The size EdgeFace saw. identify judges its Identifiable Face floor in those
// pixels rather than the photograph's, and keeps no copy of the number.
export { DECODE_BOUND } from "./lib/decode-bound";
