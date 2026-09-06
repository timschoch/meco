import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ComposeError } from "../errors";

/**
 * Every asset file already read, by absolute path.
 *
 * The memo is keyed by path and not by Look, which is what keeps two faces
 * instanced out of one variable font file on the **same** `Uint8Array`. takumi
 * drops the second registration of a font read into a second Buffer and renders
 * every weight at the first one, silently — see the note over `face` in
 * `laica/index.ts`. Reading once per path gives that by construction rather
 * than by a constant somebody has to remember to reuse.
 *
 * Unbounded on purpose: the ceiling is the asset files compose ships, 816 KB of
 * fonts plus three wordmarks, all of which a warm process holds anyway.
 */
const HELD = new Map<string, Uint8Array>();

/**
 * A Look's reader for the files beside it: hand it `import.meta.url`, call what
 * comes back with a path relative to the Look's own folder.
 *
 * A factory rather than a `read(relative, base)` each Look passes its own
 * `import.meta.url` to: bound once, the base cannot be got wrong at a call
 * site, and a Look says where its files are in one line instead of wrapping the
 * call again in every folder.
 *
 * Reading on first use is what lets a bundle of compose load where the files
 * are not beside it. A library that reads at import cannot be imported at all
 * without its assets: the gateway's esbuild bundle built and then died at load
 * on `Eina02-Regular.otf` for exactly that reason (#181).
 */
export function lookAssets(base: string): (relative: string) => Uint8Array {
  return (relative) => {
    const path = fileURLToPath(new URL(relative, base));
    const held = HELD.get(path);
    if (held) return held;

    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch (reason) {
      // The reason goes in the message and not in `detail`, which is for what a
      // caller acts on, such as zod's issues. There is nothing to be done about
      // this but to go and look, and ENOENT reads differently from EACCES to
      // whoever does.
      throw new ComposeError(
        "look_assets_missing",
        `A Look's asset file cannot be read: ${path} (${String(reason)}).`
      );
    }

    HELD.set(path, bytes);
    return bytes;
  };
}
