import type { Look, LookFont } from "../../../template";
import { lookAssets } from "../assets";

/** Named once: the Brand is both the Look's own id and its asset folder. */
const BRAND = "swisshutless";
const bytes = lookAssets(BRAND);

function face(family: string, weight: number, file: string): LookFont {
  return { family, weight, data: bytes(`fonts/${file}`) };
}

/**
 * Swiss Hutless Karts AG — karting chassis and race kit.
 *
 * Loud, high-contrast and motorsport-flavoured: near-black field, condensed
 * uppercase headings. Red and navy are sampled from the shop's own logo, not
 * chosen: red carries every accent, navy is the secondary the wordmark uses.
 * That same logo ships as the wordmark; it carries its own light plate, so it
 * reads on the dark frame.
 *
 * Barlow and Barlow Condensed ship in `fonts/` under the OFL beside them. The
 * prototype fetched them from Google on every cold start; committing them is
 * what makes compose network-free.
 */
export const swisshutless = {
  brand: BRAND,
  colors: {
    red: "#d80028",
    redDark: "#a80020",
    navy: "#304898",
    black: "#0a0a0c",
    graphite: "#1b1d21",
    white: "#f8f8f8",
    silver: "#c8ccd2",
  },
  fonts: () => [
    face("Barlow Condensed", 400, "BarlowCondensed-Regular.ttf"),
    face("Barlow Condensed", 600, "BarlowCondensed-SemiBold.ttf"),
    face("Barlow Condensed", 700, "BarlowCondensed-Bold.ttf"),
    face("Barlow", 400, "Barlow-Regular.ttf"),
    face("Barlow", 600, "Barlow-SemiBold.ttf"),
    face("Barlow", 700, "Barlow-Bold.ttf"),
  ],
  headingFamily: "Barlow Condensed",
  bodyFamily: "Barlow",
  logo: () => bytes("logo.png"),
} as const satisfies Look;
