// Bundles the container entry point into one file, so the runtime image needs
// no node_modules: pnpm's workspace symlinks do not survive a COPY.
import { build } from "esbuild";

await build({
  entryPoints: ["server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: "dist/bundle",
  // compose's index is reached by `list_templates` through a dynamic import
  // and carries two natives, which load their binaries by their own paths and
  // cannot be bundled (the models image keeps the same two outside its
  // bundle). Splitting keeps that import dynamic, so the chunk that names the
  // externals loads on the first call and not at boot. The runtime image does
  // not carry them yet: that is #183's work, ledgered on #181, and until then
  // the one route that imports compose answers 500 on a deployment while every
  // other route serves.
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
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
