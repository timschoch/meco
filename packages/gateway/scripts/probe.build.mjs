// Bundles the probe into one file so plain `node` can run it, the way
// `packages/models/scripts/probe.build.mjs` does: the workspace imports carry
// no file extensions, which Node's ESM loader does not resolve.
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/probe.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/probe/probe.js",
});
