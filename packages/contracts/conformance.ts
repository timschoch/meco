// Entry point for the Conformance Checks. Separate from `index.ts` so the
// fixture handling the checks pull in never reaches the runtime graph.
export {
  schemaConformance,
  type Check,
  type Sample,
  type SchemaSamples,
} from "./lib/schema-conformance";
export {
  adapterConformance,
  type AdapterFixtures,
} from "./lib/adapter-conformance";
