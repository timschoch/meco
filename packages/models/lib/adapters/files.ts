import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the adapter folders are. In source that is this directory,
 * `lib/adapters/`; in the container it is the bundle's own directory, into
 * which `build.mjs` copies each adapter's weights and licence under the
 * adapter's name. Both resolve from `import.meta.url`, so an adapter never
 * spells a path and the bundle needs no environment variable to find its files.
 */
const ADAPTERS_DIR = fileURLToPath(new URL("./", import.meta.url));

/** A file beside an adapter: `adapterFile("yunet", "weights.sha256")`. */
export const adapterFile = (adapter: string, file: string): string =>
  join(ADAPTERS_DIR, adapter, file);

/**
 * The verbatim licence text beside an adapter's weights. Read at construction
 * so that a Model without one cannot be added: a missing file throws here, an
 * empty one throws here, and either stops the Catalogue from being built.
 */
export function readLicence(adapter: string): string {
  const text = readFileSync(adapterFile(adapter, "LICENCE.txt"), "utf8");
  if (text.trim() === "") {
    throw new Error(
      `${adapter}: LICENCE.txt is empty, so its Model may not ship`
    );
  }
  return text;
}
