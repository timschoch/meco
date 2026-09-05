import { z } from "zod";

/**
 * A fraction of the image, top-left origin. Resolution-free by construction:
 * nothing a caller reads depends on the pixel size it was measured at.
 */
const fraction = z.number().min(0).max(1);

/** A point in fractions. */
export const Point = z.strictObject({
  x: fraction,
  y: fraction,
});

/** A rectangle in fractions, fully inside the image. */
export const Box = z
  .strictObject({
    x: fraction,
    y: fraction,
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
  })
  .refine((b) => b.x + b.width <= 1, {
    error: "x + width must not exceed 1",
    path: ["width"],
  })
  .refine((b) => b.y + b.height <= 1, {
    error: "y + height must not exceed 1",
    path: ["height"],
  });

/** A count of whole pixels. The one shape in contracts that is not a fraction. */
export const pixels = z.int().positive();

/** A size in whole pixels: a target, or the image the Annotation describes. */
export const Size = z.strictObject({
  width: pixels,
  height: pixels,
});

export type Point = z.infer<typeof Point>;
export type Box = z.infer<typeof Box>;
export type Size = z.infer<typeof Size>;
