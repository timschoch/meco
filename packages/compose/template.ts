// Entry point. The only import a Template author needs: the contract its module
// satisfies, the Look it renders in, and the two Markers.
import type { ReactNode } from "react";
import type { RgbaImage } from "@takumi-rs/helpers";
import type { z } from "zod";
import type { Box, RedactionDefault } from "@meco/contracts";
import type { Placement, PlacementId } from "./placements";

export { ImageSlot, Occludes } from "./lib/markers";
export { PhotoCard, Scrim, TextBlock } from "./lib/blocks";
export type { TextBlockColors, TextBlockScale } from "./lib/blocks";
export { registerTemplates } from "./lib/templates/register";

/**
 * What a Template writes in `<img src=...>` to draw its Look's wordmark.
 *
 * A name and not the bytes: takumi resolves it against the image table compose
 * registers for the render, so the Template stays free of buffers and the
 * measured tree is the same whether or not the bytes are to hand.
 */
export const LOGO_SRC = "meco:logo";

/** A font face the Look ships, with its file already read off disk. */
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
 *
 * `fonts` and `logo` are calls and not fields because they open files. compose
 * is a library: it must be importable where its asset files are not beside it,
 * so nothing is read until a `plan` or a `render` asks for it, and each file is
 * then held for the life of the process. A field would have hidden that read
 * behind what reads as a lookup — and reading at import is the defect this
 * shape exists to prevent (#209). A Template touches neither: it names families
 * and writes `LOGO_SRC`, and compose resolves both.
 */
export interface Look {
  readonly brand: string;
  readonly colors: Readonly<Record<string, string>>;
  /** The faces to register. Reads the font files on the first call. */
  fonts(): readonly LookFont[];
  /** The family headings render in. */
  readonly headingFamily: string;
  /** The family body copy renders in. */
  readonly bodyFamily: string;
  /** The wordmark, as encoded PNG bytes. Reads the file on the first call. */
  logo(): Uint8Array;
}

/**
 * The picture as a Template sees it. `src` is absent while a Plan is measured,
 * because the Plan may not depend on the bytes; `ImageSlot` renders the same
 * tree shape either way, so the layout is identical.
 */
export interface SlotImage {
  readonly src?: RgbaImage;
  /**
   * The Image Slot's pixel size while the picture is drawn, and the
   * Placement's while a Plan is measured, because the slot is what that pass
   * is measuring. A Template may read neither into its layout: doing so makes
   * the Plan disagree with the picture wherever the slot is not the whole
   * canvas. `layoutConformance` holds every Template to it.
   */
  readonly width: number;
  readonly height: number;
}

/** What a Template's `render` is handed. */
export interface TemplateProps<Fields> {
  readonly fields: Fields;
  readonly look: Look;
  readonly placement: Placement;
  readonly image: SlotImage;
  /**
   * Which of the Template's Variants to draw. Always one of the names the
   * Template declares, and absent for a Template that declares none.
   */
  readonly variant?: string;
}

/**
 * One way a Template can lay itself out: the same Fields and the same Look,
 * with its blocks somewhere else — the caption at the top instead of the
 * bottom. compose plans every Variant and frame chooses the one that keeps
 * the Subject clearest, so a Template offers them in its order of preference
 * and the first is what a picture with nothing to keep clear gets.
 */
export interface TemplateVariant {
  readonly name: string;
  /**
   * Where the Subject should land under this layout, in Image Slot fractions,
   * per Placement. Declared per Variant because the clear part of the frame
   * moves with the blocks; a Placement not named here falls back to the
   * Template's own `subjectArea`.
   */
  readonly subjectArea?: Partial<Record<PlacementId, Box>>;
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
  /**
   * This Template's rung of the Redaction Policy: what an output drawn from it
   * gets when the request said nothing (#249). Beside the Look and the
   * Variants because it is a design decision — a Template built around one
   * recognisable face has an opinion about blurring the crowd behind it.
   *
   * Absent, and absent per field, means this Template has no opinion and the
   * Brand's default answers next. compose neither reads nor applies it: it
   * declares it and the gateway resolves it, because redaction happens on the
   * Source Image long before compose is handed a window.
   */
  readonly redaction?: RedactionDefault;
  /**
   * The Variants this Template offers, most preferred first, each named once.
   * A Template that declares none lays out one way and its `render` is never
   * handed a `variant`.
   */
  readonly variants?: readonly TemplateVariant[];
  /** Real Fields that render, so a caller can see the Template working. */
  readonly example: z.infer<Fields>;
  render(props: TemplateProps<z.infer<Fields>>): ReactNode;
}

export type { Placement, PlacementId } from "./placements";
export type { Box, RedactionDefault } from "@meco/contracts";
export type { RgbaImage } from "@takumi-rs/helpers";
