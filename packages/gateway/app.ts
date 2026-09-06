// Entry point: the HTTP surface of `gateway`, both Doors, without a listening
// socket. `OPERATIONS` is the table both Doors are generated from, exported so
// a test can hold `tools/list` against it.
export { createApp, type GatewayDeps } from "./lib/app";
export { OPERATIONS, type Operation } from "./lib/operations";
export type { Health, ModelsReach } from "./lib/health";
export type { RecordsReach } from "@meco/records/health";
export type { StoreHealth, StoreReach } from "@meco/store/health";
