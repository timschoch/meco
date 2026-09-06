import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

const COMPOSE = new URL("../", import.meta.url);

/**
 * Where the bundle is written: a scratch folder under compose's own
 * `node_modules/`.
 *
 * Two things have to be true of it at once. Node must resolve the externals
 * from it — a bundle importing `sharp` finds it by walking up to
 * `packages/compose/node_modules/`, which nowhere outside the package does. And
 * the Look's font files must **not** be beside it, which is the whole point:
 * this is a bundle standing on its own, the way the gateway's container holds
 * one.
 */
const SCRATCH = mkdtempSync(
  fileURLToPath(new URL("node_modules/.compose-bundle-", COMPOSE))
);

/**
 * The natives, left out of the bundle.
 *
 * sharp and takumi ship `.node` binaries that esbuild cannot inline, so the
 * gateway marks them external and ships `node_modules` beside the bundle
 * (#181). Everything else — compose's own files, react, zod, `@meco/contracts`
 * — is bundled, which is what puts `import.meta.url` somewhere the assets are
 * not.
 */
const EXTERNAL = ["sharp", "@takumi-rs/core", "@takumi-rs/helpers"];

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("an esbuild bundle of compose", () => {
  it("loads in a process where the Look's asset files are not beside it", async () => {
    // The measurement from #181, as a test: the gateway's bundle built at
    // 1072 KB and then died at load on `fonts/Eina02-Regular.otf`, because a
    // Look read its files when its module loaded and the bundle sits nowhere
    // near them. Nothing under this folder but the bundle itself.
    const bundle = `${SCRATCH}/compose.mjs`;
    await build({
      entryPoints: [fileURLToPath(new URL("index.ts", COMPOSE))],
      outfile: bundle,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      external: EXTERNAL,
      tsconfig: fileURLToPath(new URL("tsconfig.json", COMPOSE)),
    });

    const probe = `${SCRATCH}/probe.mjs`;
    writeFileSync(
      probe,
      [
        `const compose = await import(${JSON.stringify(bundle)});`,
        `if (typeof compose.render !== "function") throw new Error("no render");`,
        `if (typeof compose.plan !== "function") throw new Error("no plan");`,
        `console.log(compose.templates().length);`,
      ].join("\n")
    );

    // A child process and not a dynamic import here: this suite has already
    // read every asset, so an import in-process would be answered from the
    // memo and prove nothing about a cold one.
    const printed = execFileSync(process.execPath, [probe], {
      encoding: "utf8",
    });

    // The catalogue answers without a single file being opened, which is the
    // claim: everything but the pixels works with no assets on disk.
    expect(Number(printed.trim())).toBeGreaterThan(0);
  }, 60_000);
});
