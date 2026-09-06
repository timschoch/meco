import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
let scratch: string;

// In a hook and not at module scope: a failure here is then this suite's
// failure and not a collection error, and the folder is made after the run has
// committed to running it.
beforeAll(() => {
  scratch = mkdtempSync(
    fileURLToPath(new URL("node_modules/.compose-bundle-", COMPOSE))
  );
});

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
  rmSync(scratch, { recursive: true, force: true });
});

describe("an esbuild bundle of compose", () => {
  it("loads in a process where the Look's asset files are not beside it", async () => {
    // The measurement from #181, as a test: the gateway's bundle built at
    // 1072 KB and then died at load on `fonts/Eina02-Regular.otf`, because a
    // Look read its files when its module loaded and the bundle sits nowhere
    // near them. Nothing under this folder but the bundle itself.
    const bundle = `${scratch}/compose.mjs`;
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

    const probe = `${scratch}/probe.mjs`;
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

  it("renders when each Look's files sit beside it under the Brand's name", async () => {
    // The other half of the same claim, and the layout the gateway's image is
    // built to (#183): a bundle collapses all three Looks into one file, so a
    // Look asking for `./logo.png` relative to its own module would ask three
    // times for one path. `lookAssets` resolves `<its own directory>/<brand>/`
    // instead, which is `lib/looks/<brand>/` in source and this folder in a
    // bundle. Nothing here reads compose's source tree.
    const bundle = `${scratch}/with-assets/compose.mjs`;
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

    const looks = new URL("lib/looks/", COMPOSE);
    for (const entry of readdirSync(looks, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      cpSync(
        fileURLToPath(new URL(`${entry.name}/`, looks)),
        `${scratch}/with-assets/${entry.name}`,
        { recursive: true, filter: (source) => !source.endsWith(".ts") }
      );
    }

    const probe = `${scratch}/with-assets/probe.mjs`;
    // The Swiss Hutless story, whose wordmark is one of the three `logo.png`
    // files that would collide: a bundle reading the wrong one still renders,
    // so the Plan's own Image Slot is cut whole and the picture is drawn.
    writeFileSync(
      probe,
      [
        `const { plan, render, templates } = await import(${JSON.stringify(bundle)});`,
        `const described = templates("swisshutless").find((t) => t.id === "swisshutless-story");`,
        `const input = { template: "swisshutless-story", placement: "instagram/story", brand: "swisshutless", fields: described.example };`,
        `const [{ imageSlot }] = await plan(input);`,
        `const source = { width: imageSlot.width, height: imageSlot.height, channels: 3, data: Buffer.alloc(imageSlot.width * imageSlot.height * 3, 90) };`,
        `const out = await render({ ...input, source, window: { x: 0, y: 0, width: 1, height: 1 }, format: "png" });`,
        `console.log(out.bytes.byteLength);`,
      ].join("\n")
    );

    const printed = execFileSync(process.execPath, [probe], {
      encoding: "utf8",
    });

    expect(Number(printed.trim())).toBeGreaterThan(0);
  }, 120_000);
});
