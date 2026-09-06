import type { Look, LookFont } from "../../../template";
import { lookAssets } from "../assets";

/** Named once: the Brand is both the Look's own id and its asset folder. */
const BRAND = "laica";
const bytes = lookAssets(BRAND);

/**
 * One weight instanced out of a variable font file.
 *
 * `data` **must** be the same object for every weight of one file. Measured on
 * takumi 2.13.6: register one Buffer twice, as Outfit 400 and 500, and
 * "LOGBUCH" at 24 px measures 123.92 and 125.15 px — two instances of the
 * `wght` axis. Read the same file into two Buffers and both measure 123.92: the
 * second registration is dropped and every weight renders at the first one.
 * Nothing warns; the picture just comes out one weight throughout.
 *
 * `lookAsset` memoises by path, so the two Outfit faces below are the same
 * bytes however often `fonts()` is called. That is what the identity rests on
 * now the files are read on first use rather than at import (#209).
 *
 * Swiss Hutless is unaffected — its weights are separate static files, so its
 * faces are separate bytes by construction.
 */
function face(family: string, weight: number, file: string): LookFont {
  return { family, weight, data: bytes(file) };
}

const OUTFIT = "fonts/outfit/Outfit-Variable.ttf";
const FIGTREE = "fonts/figtree/Figtree-Variable.ttf";

/**
 * laica — bright, calm, precise B2B consulting.
 *
 * Paper-white field, Pine Ink text, and one green that only ever marks
 * orientation: a rule, a chip, a hairline, never a filled headline. Hierarchy
 * comes from size and rhythm rather than boldness, which is why the headings
 * are 400 and the loudest weight in the Look is 500.
 *
 * The colours are the design system's oklch values converted to sRGB, which is
 * what the live site paints.
 *
 * Outfit and Figtree ship as variable files in `fonts/`, each in its own folder
 * beside its own OFL: they are two projects with two copyright lines, so one
 * shared licence file would misattribute both. The prototype fetched them from
 * Google on every cold start; committing them is what makes compose
 * network-free.
 */
export const laica = {
  brand: BRAND,
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
  fonts: () => [
    face("Outfit", 400, OUTFIT),
    face("Outfit", 500, OUTFIT),
    face("Figtree", 400, FIGTREE),
  ],
  headingFamily: "Outfit",
  bodyFamily: "Figtree",
  logo: () => bytes("logo.png"),
} as const satisfies Look;
