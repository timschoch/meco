import sharp from "sharp";

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
