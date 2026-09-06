// Bundles the probe into one file so plain `node` can run it.
//
// The packages import each other without file extensions, which TypeScript and
// Vitest resolve and Node's ESM loader does not, so `node scripts/probe.ts`
// dies on the first workspace import. `packages/records/seed.build.mjs`
// answers the same question the same way; the probe borrows it rather than
// bringing a second TypeScript runner into the repo for one script.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// The default fixture, resolved here and baked in: the bundle sits at a
// different depth than the source, so neither `import.meta.url` nor the
// working directory names the same folder in both.
const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

await build({
  entryPoints: ["scripts/probe.ts"],
  define: { __FIXTURES__: JSON.stringify(fixtures) },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist/probe/probe.js",
});
