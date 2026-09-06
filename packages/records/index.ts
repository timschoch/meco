// Entry point: the runtime surface of `@meco/records`. Everything under `lib/`
// is private to this package.
//
// `pgliteDatabase` is deliberately not here: it lives at
// `@meco/records/pglite`, so the gateway's bundle never pulls PGlite's
// WebAssembly in behind an export it does not call.
export { type Database, type DatabaseKind } from "./lib/database";
export { neonDatabase } from "./lib/neon";
export {
  type FileRecord,
  type NewFile,
  type Records,
  type RecordsOptions,
  records,
} from "./lib/records";
