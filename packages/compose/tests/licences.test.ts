import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every font compose ships, found on disk rather than through the Look modules:
 * a font file nobody imports still ships in the container, and it is exactly
 * the one whose licence gets forgotten.
 */
const LOOKS = new URL("../lib/looks/", import.meta.url);

const FONT_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"];
const LICENCE_NAMES = ["OFL.txt", "LICENCE.txt", "LICENSE.txt", "LICENCE.md"];

/** Long enough to be a licence and not a stub. The OFL runs about 4.4 KB. */
const SHORTEST_PLAUSIBLE_LICENCE = 500;

function fontFiles(dir: URL): URL[] {
  const found: URL[] = [];
  for (const name of readdirSync(fileURLToPath(dir))) {
    const child = new URL(name, dir);
    if (statSync(fileURLToPath(child)).isDirectory()) {
      found.push(...fontFiles(new URL(`${name}/`, dir)));
    } else if (FONT_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      found.push(child);
    }
  }
  return found;
}

const FONTS = fontFiles(LOOKS);

describe("font licences", () => {
  it("finds the fonts the Looks ship", () => {
    expect(FONTS.length).toBeGreaterThan(0);
  });

  it.each(FONTS.map((f) => [f.pathname.split("/").slice(-3).join("/"), f]))(
    "%s has its licence text beside it",
    (_name, font) => {
      const dir = new URL(".", font);
      const licence = LICENCE_NAMES.map((n) => new URL(n, dir)).find((url) => {
        try {
          return statSync(fileURLToPath(url)).isFile();
        } catch {
          return false;
        }
      });

      expect(licence, `no licence file beside ${font.pathname}`).toBeDefined();
      const text = readFileSync(fileURLToPath(licence!), "utf8");
      expect(text.length).toBeGreaterThan(SHORTEST_PLAUSIBLE_LICENCE);
    }
  );
});
