// Entry point. `contracts` depends on no other package: it is what the others
// agree on. Module agents add the real shared types here.
export { MODULE_NAMES, type ModuleName } from "./lib/module-name";
export { Box, Point, Size } from "./lib/geometry";
export {
  ANNOTATION_SCHEMA,
  Annotation,
  Embedding,
  Landmarks,
  ModelId,
  Region,
  RegionKind,
} from "./lib/annotation";
