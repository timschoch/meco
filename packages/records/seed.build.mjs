// Bundles the Seed into one file so plain `node` can run it.
//
// The packages import each other without file extensions, which TypeScript and
// Vitest resolve and Node's ESM loader does not, so `node seed.ts` dies on the
// first workspace import. Bundling is how `gateway` already answers the same
// question (`packages/gateway/build.mjs`); the Seed borrows it rather than
// bringing a second TypeScript runner into the repo for one script.
import { build } from "esbuild";

await build({
  entryPoints: ["seed.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/seed/seed.js",
  // The same shim the gateway's bundle needs: an ESM bundle has no `require`,
  // and `@vercel/blob` reaches a CommonJS `jose` that uses one. See DEPLOY.md.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});
