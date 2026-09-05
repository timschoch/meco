// Entry point: the HTTP surface of `models`, without a listening socket.
// `createApp(catalogue)` takes the real Catalogue in `server.ts` and an
// in-memory one in a test.
export { createApp, type CatalogueEntry } from "./lib/app";
export { ERROR_STATUS, type ErrorCode } from "./lib/errors";
export type { Health } from "./lib/health";
