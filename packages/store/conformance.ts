// Entry point for the Conformance Checks both adapters run. Separate from
// `index.ts` so the fixtures and assertions the checks pull in never reach the
// runtime graph — the same split `@meco/contracts` makes.
export { storeConformance, type StoreFixtures } from "./lib/store-conformance";
