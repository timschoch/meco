import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { Box } from "@meco/contracts";
import type { DecodedImage } from "../index";

const REPO_FIXTURES = new URL("../../../fixtures/", import.meta.url);

/** The kart photograph every render test starts from: 1600x1000, one visored driver. */
export const KART_FIXTURE = "karts/on-track-dark-visor.jpg";

/**
 * A repo fixture as the host would hand it to compose: raw RGB, no alpha, at
 * its own resolution. The Annotation's resolution in production; here the
 * file's own, which is what makes the window fractions below exact.
 */
export async function decode(name: string): Promise<DecodedImage> {
  const path = fileURLToPath(new URL(name, REPO_FIXTURES));
  const { data, info } = await sharp(readFileSync(path))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) {
    throw new Error(`${name} decoded to ${info.channels} channels, wanted 3.`);
  }
  return { width: info.width, height: info.height, channels: 3, data };
}

/**
 * The tallest centred window of this aspect, in fractions of a source of this
 * size. Whole source pixels first, then divided: the same order frame works in,
 * so the box compose receives is one a real caller could have sent.
 */
export function centredWindow(
  source: { width: number; height: number },
  aspect: { width: number; height: number }
): Box {
  const byHeight = Math.round((source.height * aspect.width) / aspect.height);
  const width = Math.min(byHeight, source.width);
  const height =
    width === byHeight
      ? source.height
      : Math.round((source.width * aspect.height) / aspect.width);
  const left = Math.floor((source.width - width) / 2);
  const top = Math.floor((source.height - height) / 2);
  return {
    x: left / source.width,
    y: top / source.height,
    width: width / source.width,
    height: height / source.height,
  };
}

/** A window off the wanted aspect by this many source pixels of width. */
export function widenBy(
  window: Box,
  source: { width: number },
  pixels: number
): Box {
  return { ...window, width: window.width + pixels / source.width };
}
