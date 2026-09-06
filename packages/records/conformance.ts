// Entry point for the Conformance Checks both adapters run. Separate from
// `index.ts` so the fixtures and assertions the checks pull in never reach the
// runtime graph — the same split `@meco/store` and `@meco/contracts` make.
export {
  type EmptyDatabase,
  type RecordsFixtures,
  recordsConformance,
} from "./lib/records-conformance";
