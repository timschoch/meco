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
});
