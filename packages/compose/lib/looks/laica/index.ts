import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Look, LookFont } from "../../../template";

function bytes(relative: string): Uint8Array {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)));
}

/**
 * One weight instanced out of a variable font file.
 *
 * `data` **must** be the same object for every weight of one file, which is why
 * the bytes are read once above and handed in rather than read per face.
 * Measured on takumi 2.13.6: register one Buffer twice, as Outfit 400 and 500,
 * and "LOGBUCH" at 24 px measures 123.92 and 125.15 px — two instances of the
 * `wght` axis. Read the same file into two Buffers and both measure 123.92: the
 * second registration is dropped and every weight renders at the first one.
 * Nothing warns; the picture just comes out one weight throughout.
 *
 * Swiss Hutless is unaffected — its weights are separate static files, so its
 * faces are separate bytes by construction.
 */
function face(family: string, weight: number, data: Uint8Array): LookFont {
  return { family, weight, data };
}

const OUTFIT = bytes("./fonts/outfit/Outfit-Variable.ttf");
const FIGTREE = bytes("./fonts/figtree/Figtree-Variable.ttf");

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
  brand: "laica",
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
    face("Outfit", 400, OUTFIT),
    face("Outfit", 500, OUTFIT),
    face("Figtree", 400, FIGTREE),
  ],
  headingFamily: "Outfit",
  bodyFamily: "Figtree",
  logo: bytes("./logo.png"),
} as const satisfies Look;
