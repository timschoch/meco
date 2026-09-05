import type { Match, Redaction, Region } from "@meco/contracts";
import type { DecodedImage } from "./decoded-image";
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
 * Asynchronous from the start because the mask is drawn with sharp, which
 * lands in #131. Until then the returned `image` is the request's own buffer.
 */
export const redact = async (request: RedactRequest): Promise<RedactResult> => {
  if (!request.redaction.blurUnknownFaces) {
    return { image: request.image, redactions: [] };
  }

  const hidden = unknownFaces(request.regions, request.matches);

  return {
    image: request.image,
    redactions: hidden.map((region) => ({
      regionId: region.id,
      reason: "unknown-face",
    })),
  };
};
