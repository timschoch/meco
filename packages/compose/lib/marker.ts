import type { MeasuredNode, Node } from "@takumi-rs/core";

/**
 * The attribute a Marker writes so compose can find it again in the layout.
 * A data attribute and not `id` or `className`: `Occludes` appears any number
 * of times, and a Template's own styling must never be able to collide with it.
 */
export const MARKER_ATTRIBUTE = "data-meco";

export const IMAGE_SLOT_MARKER = "image-slot";
export const OCCLUDES_MARKER = "occludes";

/** A box in canvas pixels, read off a measured node's absolute transform. */
export interface MeasuredBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function markerOf(node: Node): string | undefined {
  const value = node.attributes?.[MARKER_ATTRIBUTE];
  return typeof value === "string" ? value : undefined;
}

function childrenOf(node: Node): readonly Node[] {
  return node.type === "container" ? (node.children ?? []) : [];
}

/**
 * Every box carrying this Marker, in canvas pixels.
 *
 * takumi's measured tree carries no ids, but it mirrors the source tree node
 * for node, so the two are walked in step: the source node says what a box is,
 * the measured node says where it is. The transform is absolute, so its last
 * two components are the box's canvas origin (verified on a nested tree,
 * ADR-0009 decision 2).
 *
 * A Template that renders a different tree with and without image bytes would
 * desynchronise the two walks. The Markers keep the shape constant for exactly
 * that reason.
 */
export function findMarked(
  source: Node,
  measured: MeasuredNode,
  marker: string
): MeasuredBox[] {
  const found: MeasuredBox[] = [];

  const walk = (node: Node, box: MeasuredNode): void => {
    if (markerOf(node) === marker) {
      found.push({
        x: box.transform[4],
        y: box.transform[5],
        width: box.width,
        height: box.height,
      });
    }
    const kids = childrenOf(node);
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      const measuredChild = box.children[i];
      if (child === undefined || measuredChild === undefined) return;
      walk(child, measuredChild);
    }
  };

  walk(source, measured);
  return found;
}
