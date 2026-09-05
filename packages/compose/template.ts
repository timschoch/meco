// Entry point. The only import a Template author needs: the contract its module
// satisfies, the Look it renders in, and the two Markers.
import type { ReactNode } from "react";
import type { RgbaImage } from "@takumi-rs/helpers";
import type { z } from "zod";
import type { Box } from "@meco/contracts";
import type { Placement, PlacementId } from "./placements";

export { ImageSlot, Occludes } from "./lib/markers";

/**
 * What a Template writes in `<img src=...>` to draw its Look's wordmark.
 *
 * A name and not the bytes: takumi resolves it against the image table compose
 * registers for the render, so the Template stays free of buffers and the
 * measured tree is the same whether or not the bytes are to hand.
 */
export const LOGO_SRC = "meco:logo";

/** A font face the Look ships, already read off disk. */
export interface LookFont {
  /** The family a Template names in `fontFamily`. */
  readonly family: string;
  readonly weight: number;
  readonly data: Uint8Array;
}

/**
 * How a Brand's Templates look: colours, fonts and wordmark.
 *
 * Code and not data, so the Look and the Templates written against it are
 * edited together and typechecked together. `colors` is still an open map here:
 * a Template is handed the `Look` its Brand resolves to at run time, so nothing
 * yet ties `swisshutless-story` to the Swiss Hutless palette at the type level.
 * Narrowing that is worth doing when a second Look exists to get it wrong.
 */
export interface Look {
  readonly brand: string;
  readonly colors: Readonly<Record<string, string>>;
  readonly fonts: readonly LookFont[];
  /** The family headings render in. */
  readonly headingFamily: string;
  /** The family body copy renders in. */
  readonly bodyFamily: string;
  /** The wordmark, as encoded PNG bytes. */
  readonly logo: Uint8Array;
}

/**
 * The picture as a Template sees it. `src` is absent while a Plan is measured,
 * because the Plan may not depend on the bytes; `ImageSlot` renders the same
 * tree shape either way, so the layout is identical.
 */
export interface SlotImage {
  readonly src?: RgbaImage;
  /** The Image Slot's pixel size, once compose has measured it. */
  readonly width: number;
  readonly height: number;
}

/** What a Template's `render` is handed. */
export interface TemplateProps<Fields> {
  readonly fields: Fields;
  readonly look: Look;
  readonly placement: Placement;
  readonly image: SlotImage;
}

/**
 * A Template module's default export. `id` is `<brand>-<name>`; `placements` is
 * closed, so a Placement the designer did not draw for is refused rather than
 * improvised.
 */
export interface Template<Fields extends z.ZodType = z.ZodType> {
  readonly id: string;
  readonly brand: string;
  readonly description: string;
  readonly fields: Fields;
  readonly placements: readonly PlacementId[];
  /** Where the Subject should land, in Image Slot fractions. Design intent, per Placement. */
  readonly subjectArea?: Partial<Record<PlacementId, Box>>;
  /** Real Fields that render, so a caller can see the Template working. */
  readonly example: z.infer<Fields>;
  render(props: TemplateProps<z.infer<Fields>>): ReactNode;
}

export type { Placement, PlacementId } from "./placements";
export type { Box } from "@meco/contracts";
export type { RgbaImage } from "@takumi-rs/helpers";
