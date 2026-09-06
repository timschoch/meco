// Entry point: the in-process adapter, for the gate and for a developer with
// no network. Apart from `index.ts` so that a container bundling the runtime
// surface never carries PGlite's WebAssembly with it.
export { pgliteDatabase } from "./lib/pglite-database";
