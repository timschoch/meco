// Bundles the probe into one file so plain `node` can run it.
//
// The packages import each other without file extensions, which TypeScript and
// Vitest resolve and Node's ESM loader does not, so `node scripts/probe.ts`
// dies on the first workspace import. `packages/records/seed.build.mjs`
// answers the same question the same way; the probe borrows it rather than
// bringing a second TypeScript runner into the repo for one script.
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/probe.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist/probe/probe.js",
});
