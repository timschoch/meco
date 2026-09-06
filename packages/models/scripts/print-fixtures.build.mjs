// Bundles the fixture printer into one file so plain `node` can run it.
//
// The same answer `scripts/probe.build.mjs` gives to the same question: the
// packages import each other without file extensions, which TypeScript and
// Vitest resolve and Node's ESM loader does not.
import { build } from "esbuild";
import { mkdir, readdir, rm, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The fixtures folder, resolved here and baked in: the bundle sits at a
// different depth than the source, so `import.meta.url` names a different
// folder in each.
const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

await build({
  entryPoints: ["scripts/print-fixtures.ts"],
  define: { __FIXTURES__: JSON.stringify(fixtures) },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // sharp and the ONNX Runtime load native `.node` binaries at runtime, so
  // they stay external and are required from `node_modules` as usual.
  external: ["sharp", "onnxruntime-node"],
  outfile: "dist/print-fixtures/print-fixtures.js",
});

// `lib/adapters/files.ts` finds an adapter's weights and licence beside the
// module that reads them, which in a bundle is the bundle itself. `build.mjs`
// copies the folders for the container image; here they are linked instead,
// because a local script has no reason to duplicate the weights on every run.
const adapters = new URL("../lib/adapters/", import.meta.url);
const out = new URL("../dist/print-fixtures/", import.meta.url);
await mkdir(fileURLToPath(out), { recursive: true });
for (const entry of await readdir(adapters, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const link = fileURLToPath(new URL(entry.name, out));
  // `force` covers the first run, where there is nothing to remove. Anything
  // else it throws is a real failure and takes the build down.
  await rm(link, { force: true });
  await symlink(
    fileURLToPath(new URL(`${entry.name}/`, adapters)),
    link,
    "dir"
  );
}
