/**
 * The Overlay: every Region and the Crop Window drawn over the Source
 * Thumbnail.
 *
 * Positioned elements in per cent of the picture's own box, so the drawing
 * holds at any display width — a phone, a wide screen, a printed page — with
 * nothing running. Pixels would need a script to survive the first resize, and
 * webui ships none.
 *
 * Every box here is a fraction of the **Source Image**. What the output was
 * cropped to is a different rectangle: drawing in output fractions would put
 * every Region somewhere the photograph does not have one.
 */
import type { Box } from "@meco/contracts";
import type { Overlay as OverlayData } from "./call-page";
import { percent } from "./percent";

/** One box as CSS. The one place a fraction becomes a position. */
const place = (box: Box): string =>
  `left: ${percent(box.x)}; top: ${percent(box.y)}; width: ${percent(box.width)}; height: ${percent(box.height)}`;

export function Overlay(props: { src: string; overlay: OverlayData }) {
  return (
    <div class="overlay">
      <img
        class="source"
        src={props.src}
        alt="the Source Image of this Call"
        loading="lazy"
        decoding="async"
      />
      {props.overlay.window === null ? null : (
        <div class="window" style={place(props.overlay.window)}>
          <span class="tag">crop window</span>
        </div>
      )}
      {props.overlay.regions.map((region) => (
        <div
          class="region"
          data-kind={region.kind}
          data-hidden={region.hidden ? "true" : "false"}
          style={place(region.box)}
        >
          <span class="tag">{region.label}</span>
        </div>
      ))}
    </div>
  );
}
