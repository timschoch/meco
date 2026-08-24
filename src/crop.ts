/**
 * Cropping a Source Image to a required shape. See CONTEXT.md.
 *
 * A Crop is a sibling of a Render, not a kind of one: it involves no Template.
 * Today the caller names a Crop Anchor. Tomorrow a smarter Crop will read the
 * Subject Area off a Template and choose the anchor that satisfies it — the
 * signature below is shaped so that change adds a branch, not a rewrite.
 */
import sharp from "sharp";

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

const GRAVITY: Record<CropAnchor, string> = {
  "top-left": "northwest",
  top: "north",
  "top-right": "northeast",
  left: "west",
  center: "center",
  right: "east",
  "bottom-left": "southwest",
  bottom: "south",
  "bottom-right": "southeast",
};

export interface CropRequest {
  source: Buffer;
  width: number;
  height: number;
  anchor?: CropAnchor;
  /**
   * Let the library pick the region with the most going on, instead of an
   * anchor. This is the seam the face-aware Crop will slot into.
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
  resolvedBy: "anchor" | "strategy";
  anchor?: CropAnchor;
}

export async function cropImage(req: CropRequest): Promise<CropResult> {
  const {
    source,
    width,
    height,
    anchor = "center",
    strategy,
    format = "jpeg",
    quality = 88,
  } = req;

  if (width <= 0 || height <= 0) {
    throw new Error(`Crop size must be positive, got ${width}x${height}.`);
  }
  if (!strategy && !CROP_ANCHORS.includes(anchor)) {
    throw new Error(
      `Unknown Crop Anchor "${anchor}". Use one of: ${CROP_ANCHORS.join(", ")}.`,
    );
  }

  const position = strategy
    ? strategy === "attention"
      ? sharp.strategy.attention
      : sharp.strategy.entropy
    : GRAVITY[anchor];

  let pipeline = sharp(source).resize({
    width,
    height,
    fit: "cover",
    position,
  });

  if (format === "png") pipeline = pipeline.png();
  else if (format === "webp") pipeline = pipeline.webp({ quality });
  else pipeline = pipeline.jpeg({ quality });

  const data = await pipeline.toBuffer();

  return {
    data,
    width,
    height,
    contentType: `image/${format}`,
    resolvedBy: strategy ? "strategy" : "anchor",
    ...(strategy ? {} : { anchor }),
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
