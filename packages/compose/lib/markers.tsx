import type { ReactElement, ReactNode } from "react";
import { Bitmap } from "@takumi-rs/helpers/jsx";
import type { RgbaImage } from "@takumi-rs/helpers";
import {
  IMAGE_SLOT_MARKER,
  MARKER_ATTRIBUTE,
  OCCLUDES_MARKER,
} from "./measured-tree";

interface MarkerProps {
  readonly style?: Record<string, unknown>;
  readonly children?: ReactNode;
}

const FILL = { width: "100%", height: "100%" } as const;

/**
 * Where the picture goes. Exactly one per Template.
 *
 * The Marker sits on the container, not on the picture, so the Image Slot is a
 * box the layout decides and never a box the bytes decide. The placeholder
 * child keeps the tree shape constant when there are no bytes, which is what
 * lets the Plan be measured without them.
 */
export function ImageSlot({
  src,
  style,
  children,
}: MarkerProps & { readonly src?: RgbaImage }): ReactElement {
  return (
    <div
      {...{ [MARKER_ATTRIBUTE]: IMAGE_SLOT_MARKER }}
      style={{ display: "flex", overflow: "hidden", ...style }}
    >
      {src ? (
        <Bitmap {...src} style={FILL} />
      ) : (
        <div style={{ ...FILL, display: "flex" }} />
      )}
      {children}
    </div>
  );
}

/**
 * Wraps what will cover the picture. Any number per Template. compose measures
 * each one and hands frame the boxes, so the Subject is kept out from under the
 * overlay before the crop is chosen.
 */
export function Occludes({ style, children }: MarkerProps): ReactElement {
  return (
    <div
      {...{ [MARKER_ATTRIBUTE]: OCCLUDES_MARKER }}
      style={{ display: "flex", ...style }}
    >
      {children}
    </div>
  );
}
