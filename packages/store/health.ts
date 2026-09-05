// Entry point: what the two stores look like from inside a deployment. Kept
// apart from `index.ts` so a caller that only files bytes never pulls in the
// probe, and so `gateway` inherits one call rather than a copy of this logic.
export { type StoreHealth, type StoreReach, reachStores } from "./lib/health";
export type { Rung } from "./lib/credentials";
