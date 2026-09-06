// Entry point: the HTTP surface of `gateway`, without a listening socket.
export { createApp, type AppDependencies } from "./lib/app";
export type { Health, ModelsReach } from "./lib/health";
export type { RecordsReach } from "@meco/records/health";
export type { StoreHealth, StoreReach } from "@meco/store/health";
