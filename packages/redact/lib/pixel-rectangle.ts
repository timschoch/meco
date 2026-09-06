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
 * A Region's box in Source Image pixels.
 *
 * **Both edges are rounded before the width is taken.** Rounding the width
 * itself lets the rectangle drift a pixel wider than the Region — on
 * `artemis-2-crew.jpg` `round(0.078706 x 1280)` is 101 against the 100 pixels
 * between the rounded edges — and a mask a pixel too wide is a mask that
 * blurs a pixel of the photograph nobody asked it to.
 *
 * This is the ellipse's own rectangle and it is never clipped: the ellipse
 * belongs to the face, not to the image it happens to lie on.
 */
export const pixelRectangle = (
  box: Box,
  image: Pick<DecodedImage, "width" | "height">
): PixelRectangle => {
  const left = Math.round(box.x * image.width);
  const top = Math.round(box.y * image.height);

  return {
    left,
    top,
    width: Math.round((box.x + box.width) * image.width) - left,
    height: Math.round((box.y + box.height) * image.height) - top,
  };
};

/**
 * The part of `rect` inside the image, or `undefined` when there is none.
 *
 * Two things end here. One is the Region that rounds away: a box above zero
 * that covers no whole pixel has nothing to blur, and `redact` reports no
 * Record for it because nothing was hidden.
 *
 * The other is the image edge, and there this is a **guard, not a path**:
 * `@meco/contracts` refuses a Region whose `x + width` exceeds 1, so no
 * validated Region can reach past the boundary. It stays because a buffer
 * overrun is the wrong way to find out that the schema regressed.
 *
 * What is clipped is the **write**, never the ellipse. A face crossing the
 * boundary is covered by the visible part of its own ellipse, not by a smaller
 * ellipse re-inscribed in the sliver that is left — which would move the
 * centre, shrink the blur and cover less of the face than the face needs.
 */
export const clipToImage = (
  rect: PixelRectangle,
  image: Pick<DecodedImage, "width" | "height">
): PixelRectangle | undefined => {
  const left = clamp(rect.left, image.width);
  const top = clamp(rect.top, image.height);
  const width = clamp(rect.left + rect.width, image.width) - left;
  const height = clamp(rect.top + rect.height, image.height) - top;

  return width > 0 && height > 0 ? { left, top, width, height } : undefined;
};
