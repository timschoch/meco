// Entry point for the layout suite. Separate from `index.ts` so the fixture
// pictures the Checks are handed, and the measured tree two of them read, never
// reach the runtime graph.
export {
  layoutConformance,
  type LayoutFixtures,
} from "./lib/layout-conformance";
export type { Check } from "@meco/contracts/conformance";
