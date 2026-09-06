/**
 * The gateway's one decode, and the invariant only the gateway can hold.
 *
 * It happens after frame, because frame needs no pixel and a Replay needs no
 * decode at all (spec, "The pipeline"). The result goes to redact and then to
 * compose, which is every pixel the gateway touches.
 *
 * `resolution_mismatch` is the gateway's own: frame divides by the
 * Annotation's size and compose multiplies by the Decoded Image's, so a Region
 * fraction and a window fraction only mean the same thing while the two sizes
 * agree. models decodes bounded and reports the photograph's own size, so a
 * disagreement here is a decoder that read the same bytes two ways — silent
 * everywhere else, and a crop of the wrong part of the picture.
 */
import sharp from "sharp";
import type { Annotation, DecodedImage } from "@meco/contracts";
import { GatewayError } from "./errors";

/**
 * EXIF-rotated raw RGB at the photograph's own size, alpha dropped: the shape
 * every module downstream of the models host agrees on.
 */
export async function decodeAt(
  bytes: Uint8Array,
  annotation: Annotation
): Promise<DecodedImage> {
  const { data, info } = await sharp(bytes)
    .rotate()
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 3) {
    throw new GatewayError(
      "resolution_mismatch",
      `the source decoded to ${info.channels} channels, not the three every Region is a fraction of`
    );
  }
  if (info.width !== annotation.width || info.height !== annotation.height) {
    throw new GatewayError(
      "resolution_mismatch",
      `the source decoded to ${info.width}x${info.height} here and to ${annotation.width}x${annotation.height} where it was annotated, so a Region fraction means two things`
    );
  }

  return {
    width: info.width,
    height: info.height,
    channels: 3,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
}
