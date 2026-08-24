/**
 * Design tokens per Brand. See CONTEXT.md.
 *
 * A Brand is the look a Template renders in. Tokens live here rather than
 * inside each Template so a brand's templates cannot drift apart.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ASSETS = resolve(import.meta.dirname, "..", "assets");

function asset(rel: string): Buffer {
  return readFileSync(resolve(ASSETS, rel));
}

/** A Google Font request, resolved lazily by the renderer. */
export interface GoogleFontSpec {
  kind: "google";
  name: string;
  /** A single weight, or a variable-font range such as `"300..700"`. */
  weight: number | `${number}..${number}`;
}

/** A font file that ships with the repo. */
export interface LocalFontSpec {
  kind: "local";
  name: string;
  weight: number;
  path: string;
}

export type FontSpec = GoogleFontSpec | LocalFontSpec;

export interface Brand {
  id: string;
  /** Human name, for the discovery endpoint. */
  name: string;
  colors: Record<string, string>;
  fonts: FontSpec[];
  /** Font family names to use in template styles. */
  headingFamily: string;
  bodyFamily: string;
  logo?: Buffer;
  logoAlt?: Buffer;
}

/**
 * laica — bright, calm, precise B2B consulting.
 * Tokens from the laica design system (`DESIGN.md` in the website repo), which
 * defines them in oklch; the hex values here are those oklch values converted
 * to sRGB, which is what the live site actually paints.
 */
export const laica = {
  id: "laica",
  name: "Laica",
  colors: {
    green: "#00a461",
    greenDark: "#00884f",
    greenLight: "#ccead8",
    black: "#181c18",
    white: "#fafcfa",
    grayLight: "#eeeeee",
    grayMedium: "#9e9e9e",
    grayDark: "#555555",
  },
  fonts: [
    { kind: "google", name: "Outfit", weight: "300..700" },
    { kind: "google", name: "Figtree", weight: "300..700" },
  ],
  headingFamily: "Outfit",
  bodyFamily: "Figtree",
  logo: asset("laica/logo.png"),
} satisfies Brand;

/**
 * Hope Family — a family blog. Palette and wordmark taken from the brand's own
 * logo files; the brand font Eina 02 ships in `assets/`.
 */
export const hopefamily = {
  id: "hopefamily",
  name: "Hope Family",
  colors: {
    blue: "#00507c",
    green: "#0d9d9f",
    pink: "#ea507b",
    banana: "#fdeab2",
    latte: "#fff7df",
    black: "#0b1217",
    white: "#ffffff",
  },
  fonts: [
    {
      kind: "local",
      name: "Eina02",
      weight: 400,
      path: resolve(ASSETS, "hopefamily/Eina02-Regular.otf"),
    },
    {
      kind: "local",
      name: "Eina02",
      weight: 600,
      path: resolve(ASSETS, "hopefamily/Eina02-SemiBold.otf"),
    },
  ],
  headingFamily: "Eina02",
  bodyFamily: "Eina02",
  logo: asset("hopefamily/logo-white.png"),
  logoAlt: asset("hopefamily/logo-blue.png"),
} satisfies Brand;

/**
 * Swiss Hutless — karting chassis and race kit.
 *
 * Loud, high-contrast and motorsport-flavoured: near-black field, one racing
 * red for every accent, condensed uppercase headings.
 */
export const swisshutless = {
  id: "swisshutless",
  name: "Swiss Hutless",
  colors: {
    red: "#e2001a",
    redDark: "#b40015",
    black: "#0a0a0c",
    graphite: "#1b1d21",
    white: "#ffffff",
    silver: "#c8ccd2",
  },
  fonts: [
    { kind: "google", name: "Barlow Condensed", weight: "400..700" },
    { kind: "google", name: "Barlow", weight: "400..700" },
  ],
  headingFamily: "Barlow Condensed",
  bodyFamily: "Barlow",
} satisfies Brand;

export const BRANDS: ReadonlyMap<string, Brand> = new Map<string, Brand>([
  [laica.id, laica],
  [hopefamily.id, hopefamily],
  [swisshutless.id, swisshutless],
]);
