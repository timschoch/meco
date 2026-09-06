import type { Look, LookFont } from "../../../template";
import { lookAsset } from "../assets";

function bytes(relative: string): Uint8Array {
  return lookAsset(relative, import.meta.url);
}

function face(family: string, weight: number, file: string): LookFont {
  return { family, weight, data: bytes(`./fonts/${file}`) };
}

/**
 * Hope Family — a family blog.
 *
 * Photo-led and warm. The picture carries the frame, a deep blue scrim keeps
 * the type readable over any photograph, and banana is the one warm mark that
 * ties a card back to the wordmark.
 *
 * `blue` and `banana` are sampled from the brand's own wordmark and not chosen:
 * `assets/hopefamily/logo-blue.png` is two colours over transparency, #00507c
 * across 10 583 opaque pixels and #fdeab2 across 9 603, and those are the two
 * values below. The rest of the palette is the prototype's, which took them the
 * same way.
 *
 * `logo.png` is that same wordmark with its blue replaced by white, so the
 * script keeps its banana and the word FAMILY reads on a dark scrim. The two
 * originals were drawn for a light page — the white one puts FAMILY in black —
 * and neither works over a photograph. They are in git history at 4981af0
 * (`assets/hopefamily/logo-white.png`, `logo-blue.png`) for whoever needs an
 * on-light mark; the `Look` contract carries one wordmark, so only the one this
 * Brand's Templates draw is committed.
 *
 * Eina 02 ships in `fonts/`. It is proprietary, not OFL like the other Looks'
 * faces: `fonts/LICENCE.txt` records what the binaries state and what is still
 * owed (#116).
 */
export const hopefamily = {
  brand: "hopefamily",
  colors: {
    blue: "#00507c",
    green: "#0d9d9f",
    pink: "#ea507b",
    banana: "#fdeab2",
    latte: "#fff7df",
    black: "#0b1217",
    white: "#ffffff",
  },
  fonts: () => [
    face("Eina02", 400, "Eina02-Regular.otf"),
    face("Eina02", 600, "Eina02-SemiBold.otf"),
  ],
  headingFamily: "Eina02",
  bodyFamily: "Eina02",
  logo: () => bytes("./logo.png"),
} as const satisfies Look;
