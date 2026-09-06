// Entry point: the runtime surface of `@meco/records`. Everything under `lib/`
// is private to this package.
//
// `pgliteDatabase` is deliberately not here: it lives at
// `@meco/records/pglite`, so the gateway's bundle never pulls PGlite's
// WebAssembly in behind an export it does not call.
export { type Brand, type Brands } from "./lib/brands";
export { type Caller, type Callers, type NewCaller } from "./lib/callers";
export {
  type Call,
  type CallError,
  type CallKind,
  type CallQuery,
  type CallStatus,
  type Calls,
  type NewCall,
  type Step,
} from "./lib/calls";
export { type Database, type DatabaseKind } from "./lib/database";
export {
  type NewOutput,
  type Output,
  type OutputDeletion,
  type OutputKind,
  type OutputQuery,
  type Outputs,
} from "./lib/outputs";
export { type Page } from "./lib/page";
export { neonDatabase } from "./lib/neon-database";
export {
  type Erasure,
  type NewReferencePhoto,
  type People,
  type Person,
  type PersonWithPrints,
  type ReferencePhoto,
  type Unenrolment,
  peoplePrefix,
} from "./lib/people";
export { type Sources } from "./lib/sources";
export { DEFAULT_RETENTION_DAYS, type SweepReport } from "./lib/sweep";
export {
  type FileRecord,
  type NewFile,
  type Records,
  type RecordsOptions,
  records,
} from "./lib/records";
