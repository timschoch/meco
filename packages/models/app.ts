// Entry point: the HTTP surface of `models`, without a listening socket.
// `createApp(catalogue)` takes the real Catalogue in `server.ts` and an
// in-memory one in a test.
export { createApp } from "./lib/app";
export { ERROR_STATUS, type ErrorCode } from "./lib/errors";
// The wire's own schemas, the ones `index.ts` hands the client. The host types
// its answers against them so the two sides cannot drift.
export type { CatalogueEntry, ModelsHealth } from "./lib/wire";
