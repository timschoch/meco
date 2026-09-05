import type { DecodedImage, Match, Redaction, Region } from "@meco/contracts";
import { paintMask } from "./mask";
import { pixelRectangle } from "./pixel-rectangle";
import { unknownFaces } from "./unknown-faces";

/**
 * One redaction call.
 *
 * What it does not name is the point: no window, no target size, no format, no
 * quality, no Brand, no threshold. redact works on the Source Image before
 * anything is cut out of it, so it cannot hold an opinion about framing, and it
 * is handed Matches rather than similarities, so it cannot hold one about
 * identity.
 */
export interface RedactRequest {
  /** The Source Image, decoded once by the models host. */
  readonly image: DecodedImage;
  /** The Annotation's Regions, boxes in Source Image fractions. */
  readonly regions: readonly Region[];
  /** The Matches of this call, for this Brand. */
  readonly matches: readonly Match[];
  /** The FramingRequest's redaction policy. */
  readonly redaction: Redaction;
}

/** What redact reports for one face it hid. */
export interface RedactionRecord {
  readonly regionId: string;
  readonly reason: "unknown-face";
}

export interface RedactResult {
  /** The Source Image, same size and same channels. */
  readonly image: DecodedImage;
  /** One Record per Unknown Face hidden, sorted by `regionId`. */
  readonly redactions: readonly RedactionRecord[];
}

/**
 * Hides every Unknown Face in the Source Image and says which ones it hid.
 *
 * The masks are painted into a copy, so the image the caller handed in is
 * still the image it handed in. Turning the policy off, or having nothing to
 * hide, costs not even that copy: the request's own buffer comes straight back
 * out, which is what `blurUnknownFaces: false` returning the input byte for
 * byte means.
 */
export const redact = async (request: RedactRequest): Promise<RedactResult> => {
  const hidden = request.redaction.blurUnknownFaces
    ? unknownFaces(request.regions, request.matches)
    : [];

  if (hidden.length === 0) {
    return { image: request.image, redactions: [] };
  }

  const data = Uint8Array.from(request.image.data);
  for (const region of hidden) {
    const rect = pixelRectangle(region.box, request.image);
    if (rect) await paintMask(request.image, data, rect);
  }

  return {
    image: { ...request.image, data },
    redactions: hidden.map((region) => ({
      regionId: region.id,
      reason: "unknown-face",
    })),
  };
};
