/**
 * Cropping a Source Image to a required shape. See CONTEXT.md.
 *
 * A Crop is a sibling of a Render, not a kind of one: it involves no Template.
 * What it is not any more is a gravity string handed to the image library. Every
 * framing input — the Crop Anchor the caller named, the saliency point sharp
 * reads out of the picture, a matched face once there is one — becomes a Subject
 * Box, and `solveCrop` in `./crop-solver.js` turns the Subject Boxes into the
 * window. This file is the half that has to touch pixels; the framing itself
 * lives next door, where it can be tested without an image.
 */
import sharp from "sharp";

import {
  solveCrop,
  type CropFallback,
  type CropProducer,
  type FractionPoint,
  type PixelSize,
  type SubjectBox,
} from "./crop-solver.js";

/** The nine regions of a Source Image a Crop can keep. */
export const CROP_ANCHORS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;

export type CropAnchor = (typeof CROP_ANCHORS)[number];

/** Where in a Template's Image Slot the Subject must land. Declared by a Template. */
export interface SubjectArea {
  /** Fractions of the slot, 0..1 from the top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where a Crop Anchor puts its point — in the Source Image and in the frame.
 *
 * One table for both, because a Crop Anchor is precisely the statement that
 * those two agree: "top-left" keeps the top-left corner of the picture in the
 * top-left corner of the frame. That is what makes the anchor a Subject Box
 * like any other instead of a special case inside the solver.
 */
const ANCHOR_AT: Record<CropAnchor, FractionPoint> = {
  "top-left": { x: 0, y: 0 },
  top: { x: 0.5, y: 0 },
  "top-right": { x: 1, y: 0 },
  left: { x: 0, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  right: { x: 1, y: 0.5 },
  "bottom-left": { x: 0, y: 1 },
  bottom: { x: 0.5, y: 1 },
  "bottom-right": { x: 1, y: 1 },
};

/**
 * How the producers rank when several speak at once.
 *
 * Only one produces a box today, so the numbers do nothing yet — they are here
 * to say where a face and a matched Person will slot in, which is above all of
 * these.
 */
const PRIORITY: Record<CropProducer, number> = {
  saliency: 30,
  anchor: 20,
  centre: 10,
};

/** The short side of the resize sharp reads the saliency point from. */
const SALIENCY_READ_PX = 32;

export interface CropRequest {
  source: Buffer;
  width: number;
  height: number;
  anchor?: CropAnchor;
  /**
   * Let the picture decide instead of the caller. Either value selects the
   * saliency producer; they differ only in which window sharp is asked for, the
   * one its attention map picks or the one its entropy map does.
   */
  strategy?: "attention" | "entropy";
  format?: "png" | "jpeg" | "webp";
  quality?: number;
}

export interface CropResult {
  data: Buffer;
  width: number;
  height: number;
  contentType: string;
  /** What actually decided the framing, for the response and for debugging. */
  resolvedBy: CropProducer;
  /** Every Subject marked `keep` survived the composition first asked for. */
  satisfied: boolean;
  /** Which rung of the fallback ladder rescued the window, if any. */
  fallback?: CropFallback;
  /** Only when the Crop Anchor decided. */
  anchor?: CropAnchor;
}

/**
 * The saliency point, in fractions of the Source Image, or null.
 *
 * sharp will only say where it is looking as a side effect of actually cropping,
 * so the read is a throwaway resize down to a 32-pixel short side — three
 * kilobytes of pixels instead of a full-size crop nobody keeps. The shape has to
 * match the shape the Crop is for, since that is the window the strategy is
 * choosing.
 *
 * The answer is read off `cropOffsetLeft/Top`, the window the strategy picked,
 * and not off `attentionX/Y`. The research note claims that field is rescaled
 * back to Source Image pixels; measured against sharp 0.35 it is not. On a
 * 1600×1000 photograph whose Subject sits at 0.68 of the width, a 32-pixel probe
 * reports `attentionX` 33 for a PNG and 264 for the same picture as a JPEG — the
 * resized-probe coordinate multiplied by whatever shrink-on-load the decoder
 * chose, which is not a factor sharp exposes. The window offset needs only the
 * resize scale undone and reads 0.645 at every probe size and in both formats.
 * Since libvips centres that window on the attention point, its centre is the
 * point back again, give or take the clamping at the edge of the picture.
 *
 * Both strategies answer the same way, so both go through here. It can also
 * legitimately answer nothing: a request whose shape already matches the Source
 * Image needs no crop, libvips skips the block, and no offset comes back. That
 * is a fall-through to the next producer, not an error.
 */
async function saliencyPoint(
  data: Buffer,
  source: PixelSize,
  aspect: number,
  strategy: "attention" | "entropy",
): Promise<FractionPoint | null> {
  const probe =
    aspect >= 1
      ? { width: Math.max(1, Math.round(SALIENCY_READ_PX * aspect)), height: SALIENCY_READ_PX }
      : { width: SALIENCY_READ_PX, height: Math.max(1, Math.round(SALIENCY_READ_PX / aspect)) };

  const { info } = await sharp(data)
    .resize(probe.width, probe.height, {
      fit: "cover",
      position: sharp.strategy[strategy],
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Negated, and in the resized image rather than the Source Image, so both have
  // to be undone before the centre of the window means anything.
  const { cropOffsetLeft, cropOffsetTop } = info;
  if (cropOffsetLeft === undefined || cropOffsetTop === undefined) return null;
  const scale = Math.max(probe.width / source.width, probe.height / source.height);
  return {
    x: (-cropOffsetLeft + probe.width / 2) / scale / source.width,
    y: (-cropOffsetTop + probe.height / 2) / scale / source.height,
  };
}

/**
 * Every Subject Box this Crop has to go on, from the producers in order.
 *
 * Saliency first when the caller asked the picture to decide, then the Crop
 * Anchor the caller named, then the centre — the anchor nobody named. The first
 * producer that yields a box wins the framing; the rest have nothing to add
 * while every producer here yields a bare point.
 */
async function subjectBoxes(
  data: Buffer,
  source: PixelSize,
  aspect: number,
  req: CropRequest,
): Promise<SubjectBox[]> {
  const point = (producer: CropProducer, at: FractionPoint, framed?: FractionPoint) => ({
    x: at.x,
    y: at.y,
    width: 0,
    height: 0,
    producer,
    priority: PRIORITY[producer],
    keep: true,
    ...(framed ? { framedAt: framed } : {}),
  });

  if (req.strategy) {
    const found = await saliencyPoint(data, source, aspect, req.strategy);
    if (found) return [point("saliency", found)];
  }
  if (req.anchor) {
    const at = ANCHOR_AT[req.anchor];
    return [point("anchor", at, at)];
  }
  const centre = ANCHOR_AT.center;
  return [point("centre", centre, centre)];
}

export async function cropImage(req: CropRequest): Promise<CropResult> {
  const { source, width, height, anchor, format = "jpeg", quality = 88 } = req;

  if (anchor !== undefined && !CROP_ANCHORS.includes(anchor)) {
    throw new Error(
      `Unknown Crop Anchor "${anchor}". Use one of: ${CROP_ANCHORS.join(", ")}.`,
    );
  }

  const meta = await sharp(source).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Could not read the size of the Source Image.");
  }
  const size: PixelSize = { width: meta.width, height: meta.height };
  const aspect = width / height;

  const boxes = await subjectBoxes(source, size, aspect, req);
  const window = solveCrop(boxes, size, { width, height });

  // Cut the window the solver chose, then scale it to the size asked for. `fill`
  // rather than `cover`, because the window is already the required shape up to
  // the rounding to whole pixels — letting sharp cover it a second time would
  // undo the framing this whole module exists to compute.
  let pipeline = sharp(source)
    .extract({
      left: window.left,
      top: window.top,
      width: window.width,
      height: window.height,
    })
    .resize(width, height, { fit: "fill" });

  if (format === "png") pipeline = pipeline.png();
  else if (format === "webp") pipeline = pipeline.webp({ quality });
  else pipeline = pipeline.jpeg({ quality });

  const data = await pipeline.toBuffer();

  return {
    data,
    width,
    height,
    contentType: `image/${format}`,
    resolvedBy: window.resolvedBy,
    satisfied: window.satisfied,
    ...(window.fallback ? { fallback: window.fallback } : {}),
    ...(window.resolvedBy === "anchor" && anchor ? { anchor } : {}),
  };
}

/** Fetch a Source Image the caller referenced by URL. */
export async function fetchSourceImage(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "user-agent": "meco/0.1 (+social image renderer)" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch source image ${url}: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
