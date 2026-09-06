// Bundles the container entry point into one file, so the runtime image needs
// no node_modules: pnpm's workspace symlinks do not survive a COPY.
import { build } from "esbuild";

await build({
  entryPoints: ["server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/bundle/server.js",
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
