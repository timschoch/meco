// Entry point: the HTTP surface of `gateway`, without a listening socket.
export { createApp } from "./lib/app";
export type { Health, ModelsReach, StoreHealth } from "./lib/health";
