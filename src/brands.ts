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
  /**
   * A single weight, a list of weights, or a range such as `"300..700"`.
   * A range only works for families Google publishes as a variable font;
   * static families (Barlow Condensed, for one) must list discrete weights or
   * the stylesheet request comes back 400.
   */
  weight: number | number[] | `${number}..${number}`;
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
 * Swiss Hutless Karts AG — karting chassis and race kit.
 *
 * Loud, high-contrast and motorsport-flavoured: near-black field, condensed
 * uppercase headings. Red and navy are sampled from the shop's own logo
 * (`shop/Bilder/shoplogo.png`), not chosen — red carries every accent, navy is
 * the secondary the wordmark uses. That same logo ships as the brand logo; it
 * carries its own light plate, so it reads on the dark frame.
 */
export const swisshutless = {
  id: "swisshutless",
  name: "Swiss Hutless",
  colors: {
    red: "#d80028",
    redDark: "#a80020",
    navy: "#304898",
    black: "#0a0a0c",
    graphite: "#1b1d21",
    white: "#f8f8f8",
    silver: "#c8ccd2",
  },
  fonts: [
    { kind: "google", name: "Barlow Condensed", weight: [400, 600, 700] },
    { kind: "google", name: "Barlow", weight: [400, 600, 700] },
  ],
  headingFamily: "Barlow Condensed",
  bodyFamily: "Barlow",
  logo: asset("swisshutless/logo.png"),
} satisfies Brand;

export const BRANDS: ReadonlyMap<string, Brand> = new Map<string, Brand>([
  [laica.id, laica],
  [hopefamily.id, hopefamily],
  [swisshutless.id, swisshutless],
]);
