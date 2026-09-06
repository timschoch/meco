// Bundles the recorder into one file so plain `node` can run it.
//
// The packages import each other without file extensions, which TypeScript and
// Vitest resolve and Node's ESM loader does not, so `node tests/record.ts` dies
// on the first workspace import. `packages/models/scripts/probe.build.mjs`
// answers the same question the same way.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Both folders are resolved here and baked in: the bundle sits at a different
// depth than the source, so neither `import.meta.url` nor the working
// directory names the same folder in both.
const sources = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const recordings = fileURLToPath(new URL("./fixtures/", import.meta.url));

await build({
  entryPoints: ["tests/record.ts"],
  define: {
    __SOURCES__: JSON.stringify(sources),
    __RECORDINGS__: JSON.stringify(recordings),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/record/record.js",
});
