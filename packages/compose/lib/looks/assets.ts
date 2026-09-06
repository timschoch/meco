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
const READ = new Map<string, Uint8Array>();

/**
 * One of a Look's asset files, read on first use and held from then on.
 *
 * `base` is the calling Look module's `import.meta.url`, passed rather than
 * resolved here so the path is the caller's own folder. Reading lazily is what
 * lets a bundle of compose load where the files are not beside it: a library
 * that reads at import cannot be imported at all without its assets, and the
 * gateway's esbuild bundle died at load on `Eina02-Regular.otf` for exactly
 * that reason (#181).
 */
export function lookAsset(relative: string, base: string): Uint8Array {
  const path = fileURLToPath(new URL(relative, base));
  const held = READ.get(path);
  if (held) return held;

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (cause) {
    throw new ComposeError(
      "look_assets_missing",
      `A Look's asset file is not on disk: ${path}.`,
      cause
    );
  }

  READ.set(path, bytes);
  return bytes;
}
