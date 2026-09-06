import sharp from "sharp";

/**
 * Whether these bytes are the format they claim, read off the file's own magic
 * number. `raster` below would decode any of the three, so the header is what
 * says which one compose actually encoded.
 */
export const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  webp: (b) =>
    String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.slice(8, 12)) === "WEBP",
};

/** JPEG q90 of a full-frame photograph is ~200 KB; anything tiny is an empty frame. */
export const SMALLEST_PLAUSIBLE_OUTPUT = 10_000;

export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Encoded bytes as raw RGB, so two pictures can be compared channel by channel. */
export async function raster(bytes: Uint8Array): Promise<Raster> {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/**
 * Mean absolute difference between two pictures, in 8-bit levels per channel.
 *
 * 0 means byte-identical; 255 is the worst two pictures can be. Reported per
 * channel rather than per pixel so the number reads the same whatever the size.
 */
export function meanAbsoluteDifference(a: Raster, b: Raster): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `Cannot compare ${a.width}x${a.height} with ${b.width}x${b.height}.`
    );
  }
  let total = 0;
  for (let i = 0; i < a.data.length; i++) {
    total += Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));
  }
  return total / a.data.length;
}
