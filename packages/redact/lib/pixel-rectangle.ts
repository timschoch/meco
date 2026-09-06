import type { Box, DecodedImage } from "@meco/contracts";

/**
 * A rectangle in Source Image pixels.
 *
 * `left`/`top`/`width`/`height`, matching sharp's `extract`; never `w`/`h`
 * ([ADR-0002](../../../docs/adr/0002-meco-faces-as-a-separate-service.md)).
 */
export interface PixelRectangle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const clamp = (value: number, limit: number): number =>
  Math.min(limit, Math.max(0, value));

/**
 * A Region's box in Source Image pixels, or `undefined` when it rounds away.
 *
 * **Both edges are rounded before the width is taken.** Rounding the width
 * itself lets the rectangle drift a pixel wider than the Region — on
 * `artemis-2-crew.jpg` `round(0.078706 x 1280)` is 101 against the 100 pixels
 * between the rounded edges — and a mask a pixel too wide is a mask that
 * blurs a pixel of the photograph nobody asked it to.
 *
 * The clamp to the image is a **guard, not a path**: `@meco/contracts` refuses
 * a Region whose `x + width` exceeds 1, so no validated Region can reach past
 * the edge. It stays because a buffer overrun is the wrong way to find out
 * that the schema regressed.
 */
export const pixelRectangle = (
  box: Box,
  image: Pick<DecodedImage, "width" | "height">
): PixelRectangle | undefined => {
  const left = clamp(Math.round(box.x * image.width), image.width);
  const top = clamp(Math.round(box.y * image.height), image.height);
  const width =
    clamp(Math.round((box.x + box.width) * image.width), image.width) - left;
  const height =
    clamp(Math.round((box.y + box.height) * image.height), image.height) - top;

  return width > 0 && height > 0 ? { left, top, width, height } : undefined;
};
