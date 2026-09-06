/**
 * Two Templates compose does not ship, for the two halves of the clipping rule.
 *
 * `registerTemplates` is the door a caller's own TSX comes through (#65), so a
 * Template the layout suite has never seen is a real case and not a hypothetical
 * one. These two stand for it: one places an Occlusion Zone wholly off its Image
 * Slot, which the Plan drops; the other places one across the slot's edge, which
 * the Plan clips and the suite forbids.
 *
 * Both draw the same frame — an Image Slot over the top half of the canvas, one
 * zone inside it — and differ only in where the second zone sits, so a rule that
 * goes red for one and green for the other is reading that difference and
 * nothing else.
 */
import { z } from "zod";
import {
  ImageSlot,
  Occludes,
  type Template,
  type TemplateProps,
} from "../template";

const Fields = z.strictObject({
  label: z.string().min(1).max(32),
});

type Fields = z.infer<typeof Fields>;

/** The Image Slot's share of the canvas. Half, so a zone has room to miss it. */
const SLOT_HEIGHT = "50%";

function frame(secondZoneTop: string) {
  return function render({ fields, look, image }: TemplateProps<Fields>) {
    return (
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          backgroundColor: look.colors.black,
        }}
      >
        <ImageSlot
          src={image.src}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: SLOT_HEIGHT,
          }}
        />

        {/* Inside the slot. The Plan keeps this one, in slot fractions. */}
        <Occludes
          style={{
            position: "absolute",
            top: 40,
            left: 40,
            width: 200,
            height: 80,
          }}
        />

        <Occludes
          style={{
            position: "absolute",
            top: secondZoneTop,
            left: 40,
            width: 400,
            height: 200,
          }}
        >
          <div style={{ fontFamily: look.bodyFamily, fontSize: 24 }}>
            {fields.label}
          </div>
        </Occludes>
      </div>
    );
  };
}

function template(id: string, description: string, secondZoneTop: string) {
  return {
    id,
    brand: "swisshutless",
    description,
    fields: Fields,
    placements: ["instagram/story"],
    example: { label: "Off the slot" },
    render: frame(secondZoneTop),
  } satisfies Template<typeof Fields>;
}

/** Second zone below the Image Slot, clear of it by 20 % of the canvas. */
export const OUTSIDE_SLOT = template(
  "swisshutless-outside-slot",
  "Fixture: an Occlusion Zone wholly below the Image Slot.",
  "70%"
);

/** Second zone across the Image Slot's bottom edge, half in and half out. */
export const CROSSING_SLOT = template(
  "swisshutless-crossing-slot",
  "Fixture: an Occlusion Zone across the Image Slot's bottom edge.",
  "45%"
);
