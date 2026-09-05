// Bundles the container entry point into one file and lays each adapter's
// weights and licence beside it, so the runtime image carries the bundle, the
// adapter folders and the two native packages the bundle leaves external.
//
// `onnxruntime-node` and `sharp` load native binaries by their own paths and
// cannot be bundled; `Dockerfile.vercel` installs them flat with `pnpm deploy`.
// Every adapter folder is copied to `dist/bundle/<adapter>/` minus its
// TypeScript, which is where `lib/adapters/files.ts` looks from the bundle.
import { build } from "esbuild";
import { cp, readdir } from "node:fs/promises";

await build({
  entryPoints: ["server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["onnxruntime-node", "sharp"],
  outfile: "dist/bundle/server.js",
});

const adapters = new URL("lib/adapters/", import.meta.url);
for (const entry of await readdir(adapters, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  await cp(new URL(`${entry.name}/`, adapters), `dist/bundle/${entry.name}/`, {
    recursive: true,
    filter: (source) => !source.endsWith(".ts"),
  });
}
