// Bundles the container entry point into one file and lays each Look's asset
// files beside it, so the runtime image carries the bundle, the three Look
// folders and the two native packages the bundle leaves external.
//
// `sharp` and `@takumi-rs/core` load native binaries by their own paths and
// cannot be bundled (the `models` image keeps `sharp` and `onnxruntime-node`
// outside its bundle for the same reason); `Containerfile` installs them flat
// with `pnpm deploy`. Every Look folder is then copied to
// `dist/bundle/<brand>/` minus its TypeScript, which is where compose looks
// from a bundle: `lib/looks/assets.ts` resolves `<its own directory>/<brand>/
// <file>`, and in a single-file bundle its own directory is this one.
import { build } from "esbuild";
import { cp, readdir } from "node:fs/promises";

await build({
  entryPoints: ["server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/bundle/server.js",
  external: ["sharp", "@takumi-rs/core"],
  // An ESM bundle has no `require`, so esbuild replaces a CommonJS dependency's
  // `require(…)` with a shim that throws. `@vercel/blob` reaches `jose` through
  // `@vercel/oidc`, and jose's CommonJS build requires `node:buffer` that way,
  // which took down `/health` with `Dynamic require of "node:buffer" is not
  // supported` on deployment dpl_3paWgFYje3P2EQxHgrvzDUQQgj3S, 6 Sep 2026.
  // esbuild's shim defers to a `require` already in scope, so defining one is
  // the whole fix. See DEPLOY.md.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});

const looks = new URL("../compose/lib/looks/", import.meta.url);
for (const entry of await readdir(looks, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  await cp(new URL(`${entry.name}/`, looks), `dist/bundle/${entry.name}/`, {
    recursive: true,
    filter: (source) => !source.endsWith(".ts"),
  });
}
