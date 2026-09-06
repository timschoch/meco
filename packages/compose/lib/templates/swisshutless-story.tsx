/**
 * Swiss Hutless — a full-screen story.
 *
 * The photograph is the whole frame. A scrim darkens only the third the type
 * sits in so it keeps its contrast while the picture stays untouched where the
 * Subject sits, a red stripe runs down the left edge, and one block carries
 * the kicker, the headline and the wordmark. That block is the only thing
 * covering the picture, so it is the only `Occludes`.
 *
 * Two Variants, the same block at the bottom or at the top, with the scrim
 * turned to match. `caption-bottom` is the design and comes first;
 * `caption-top` exists because a 3:2 photograph into a story is a full-height
 * column, and a kart at the bottom of one sat under the caption on every call
 * (#228). Nothing about the Look moves between them.
 *
 * Redrawn against the Template contract, not ported: the prototype's
 * `swisshutless-race.tsx` is evidence for the Look, not a source file.
 */
import { z } from "zod";
import {
  ImageSlot,
  LOGO_SRC,
  Occludes,
  type Template,
  type TemplateProps,
} from "../../template";

const Fields = z.strictObject({
  /** The loud line. Uppercased by the Template. */
  headline: z.string().min(1).max(48),
  /** The small red line above it, e.g. "Nächstes Rennen". */
  kicker: z.string().min(1).max(32),
  /** Town and country, or whatever places the headline. */
  subline: z.string().max(64).optional(),
  /** Already formatted for display, e.g. "12. – 14. Juni 2026". */
  footnote: z.string().max(48).optional(),
});

type Fields = z.infer<typeof Fields>;

// The wordmark ships at 303x166; keep that ratio so it never squashes.
const LOGO_HEIGHT = 74;
const LOGO_WIDTH = Math.round((LOGO_HEIGHT * 303) / 166);

const PAD = 92;

/**
 * The scrim, darkening the third the block sits in and leaving the rest of the
 * picture alone. Written for the bottom and turned over for the top, so the
 * two Variants share every stop.
 */
const STOPS =
  "rgba(10,10,12,0.30) 0%, rgba(10,10,12,0) 14%, rgba(10,10,12,0) 46%, rgba(10,10,12,0.84) 76%, rgba(10,10,12,0.97) 100%";

function render({ fields, look, image, variant }: TemplateProps<Fields>) {
  const c = look.colors;
  const top = variant === "caption-top";

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: c.black,
      }}
    >
      <ImageSlot
        src={image.src}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
        }}
      />

      {/* The photo stays clear away from the block; only its third darkens. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          backgroundImage: `linear-gradient(to ${top ? "top" : "bottom"}, ${STOPS})`,
        }}
      />

      {/* Brand stripe down the left edge. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 16,
          height: "100%",
          backgroundColor: c.red,
        }}
      />

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          justifyContent: top ? "flex-start" : "flex-end",
          width: "100%",
          height: "100%",
          padding: PAD,
        }}
      >
        <Occludes style={{ flexDirection: "column" }}>
          <div
            style={{
              fontFamily: look.bodyFamily,
              fontSize: 30,
              fontWeight: 600,
              letterSpacing: 5,
              color: c.red,
              marginBottom: 20,
            }}
          >
            {fields.kicker.toUpperCase()}
          </div>

          <div
            style={{
              fontFamily: look.headingFamily,
              fontSize: 112,
              fontWeight: 700,
              lineHeight: 1.02,
              color: c.white,
            }}
          >
            {fields.headline.toUpperCase()}
          </div>

          {fields.subline ? (
            <div
              style={{
                fontFamily: look.bodyFamily,
                fontSize: 40,
                color: c.silver,
                marginTop: 26,
              }}
            >
              {fields.subline}
            </div>
          ) : null}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 36,
              paddingTop: 32,
              borderTopWidth: 4,
              borderTopColor: c.red,
              borderTopStyle: "solid",
            }}
          >
            <div
              style={{
                fontFamily: look.headingFamily,
                fontSize: 54,
                fontWeight: 700,
                color: c.white,
              }}
            >
              {fields.footnote ?? ""}
            </div>
            <img src={LOGO_SRC} width={LOGO_WIDTH} height={LOGO_HEIGHT} />
          </div>
        </Occludes>
      </div>
    </div>
  );
}

/** The clear half of the frame under each Variant, the same box at both story Placements. */
const ABOVE_THE_BLOCK = { x: 0.1, y: 0.08, width: 0.8, height: 0.42 };
const BELOW_THE_BLOCK = { x: 0.1, y: 0.5, width: 0.8, height: 0.42 };

/**
 * The Subject Area is design intent, not a layout result: the Subject belongs
 * in the half the block leaves clear, so each Variant declares its own.
 */
const swisshutlessStory: Template<typeof Fields> = {
  id: "swisshutless-story",
  brand: "swisshutless",
  description:
    "Full-screen Swiss Hutless story: the photograph edge to edge, a red stripe, and one block of type over a scrim at the bottom, or at the top when the Subject sits low.",
  fields: Fields,
  placements: ["instagram/story", "facebook/story"],
  variants: [
    {
      name: "caption-bottom",
      subjectArea: {
        "instagram/story": ABOVE_THE_BLOCK,
        "facebook/story": ABOVE_THE_BLOCK,
      },
    },
    {
      name: "caption-top",
      subjectArea: {
        "instagram/story": BELOW_THE_BLOCK,
        "facebook/story": BELOW_THE_BLOCK,
      },
    },
  ],
  example: {
    headline: "Wohlen",
    kicker: "Nächstes Rennen",
    subline: "Wohlen, Schweiz",
    footnote: "12. – 14. Juni 2026",
  },
  render,
};

export default swisshutlessStory;
