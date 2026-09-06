// Entry point: what the database looks like from inside a deployment. Kept
// apart from `index.ts` so a caller that only reads rows never pulls in the
// probe, and so `gateway` inherits one call rather than a copy of this logic.
export {
  RECORDS_UNCONFIGURED,
  type RecordsReach,
  reachRecords,
  recordsTables,
} from "./lib/health";
