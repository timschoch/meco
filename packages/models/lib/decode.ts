import sharp from "sharp";
import type { Annotation, DecodedImage } from "@meco/contracts";
import { DECODE_BOUND } from "./decode-bound";
import { HostError } from "./errors";

/** What sharp calls a format, to what contracts calls its mime. */
const MIME: Record<string, Annotation["mime"]> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export interface Decoded {
  /** The pixels every adapter gets, bounded to {@link DECODE_BOUND}. */
  image: DecodedImage;
  /** The Source Image's own size after EXIF orientation, from its metadata. */
  width: number;
  height: number;
  /** What the decoder identified, never what the request header said. */
  mime: Annotation["mime"];
}

/**
 * One decode per request: EXIF-rotated, bounded, alpha dropped, raw RGB.
 * JPEG decodes with shrink-on-load, so a 12 MP photograph never materialises
 * at full size. `width` and `height` are the photograph's, so a fraction of a
 * Region is a fraction of the picture the caller holds.
 */
export async function decode(bytes: Uint8Array): Promise<Decoded> {
  const meta = await sharp(bytes)
    .metadata()
    .catch((cause: unknown) => {
      throw new HostError(
        "undecodable",
        "the body is not an image sharp can read",
        { cause }
      );
    });

  const mime = MIME[meta.format];
  if (mime === undefined) {
    throw new HostError(
      "unsupported_mime",
      `the body decodes as ${meta.format}, which is outside the set the Annotation names`
    );
  }

  // A header sharp can read does not make the rest of the file readable: a
  // truncated JPEG passes `metadata()` and fails here, and is still the
  // caller's bytes, not the host's fault.
  const { data, info } = await sharp(bytes)
    .rotate()
    .resize({
      width: DECODE_BOUND,
      height: DECODE_BOUND,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .catch((cause: unknown) => {
      throw new HostError(
        "undecodable",
        "the body is not an image sharp can decode",
        {
          cause,
        }
      );
    });
  if (info.channels !== 3) {
    throw new Error(`decode: expected 3 channels, got ${info.channels}`);
  }

  return {
    image: {
      width: info.width,
      height: info.height,
      channels: 3,
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    },
    width: meta.autoOrient.width,
    height: meta.autoOrient.height,
    mime,
  };
}
