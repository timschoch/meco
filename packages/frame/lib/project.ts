import type { Box } from "@meco/contracts";
import type { Framing } from "./framing";

/**
 * Maps a source-fraction `Box` into the frame the Crop Window cuts. One
 * caller, the gateway, which uses it to say which faces landed where in the
 * finished frame for the call record `records` keeps and `webui` shows. It
 * lives here because frame owns what the window means; a division re-derived
 * elsewhere is another chance to round it apart.
 *
 * A Box the window cut away maps outside `[0, 1]`, which is the answer the
 * caller needs: a face the Crop lost is not a face in the picture. Clipping is
 * the caller's, because what to do about it is theirs.
 */
export function projectIntoFrame(framing: Framing, box: Box): Box {
  const { x, y, width, height } = framing.windowFraction;

  return {
    x: (box.x - x) / width,
    y: (box.y - y) / height,
    width: box.width / width,
    height: box.height / height,
  };
}
