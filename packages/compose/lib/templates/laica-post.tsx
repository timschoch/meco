/**
 * laica — a LinkedIn image announcing one Logbuch post.
 *
 * The first Template whose Image Slot is not the whole canvas. The type sits
 * *beside* the picture, never under it: a 42 % column at `linkedin/wide`, a
 * 42 % plate across the top at `linkedin/post`. So the Plan's `imageSlot` is
 * narrower or shorter than the Placement — and at `linkedin/post` it does not
 * start at the canvas corner either — and the gateway hands frame that size as
 * `target` rather than the Placement's.
 *
 * The look follows the laica design system: paper-white field, Pine Ink text,
 * one green that only ever marks orientation, and 400-weight headings where
 * hierarchy comes from size and rhythm rather than boldness.
 *
 * Redrawn against the Template contract, not ported: the prototype's
 * `laica-post.tsx` is evidence for the Look, not a source file. What changed in
 * the redraw is the picture — the prototype fetched a hero from a URL in its
 * data, which compose refuses to do; the picture now arrives through the Image
 * Slot like every other Template's.
 */
import { z } from "zod";
import {
  ImageSlot,
  LOGO_SRC,
  Occludes,
  type Look,
  type Placement,
  type Template,
  type TemplateProps,
} from "../../template";

const Fields = z.strictObject({
  /** The post's own title. Set as written; the Look does not shout. */
  title: z.string().min(1).max(80),
  /** The small green line above it. "Logbuch" when the caller says nothing. */
  kicker: z.string().min(1).max(32).optional(),
  /** One or two sentences under the title. */
  excerpt: z.string().max(220).optional(),
  /** Already formatted for display, e.g. "6. September 2026". */
  date: z.string().max(32).optional(),
});

type Fields = z.infer<typeof Fields>;

/** The wordmark ships at 1200x300; keep that ratio so it never squashes. */
const LOGO_HEIGHT = 44;
const LOGO_WIDTH = Math.round((LOGO_HEIGHT * 1200) / 300);

/**
 * How much of the Placement the picture takes. The same number on both, read
 * down the long axis: the column's width at `linkedin/wide`, the band's height
 * at `linkedin/post`. 1200 and 627 both divide it whole, so nothing here rounds.
 */
const PICTURE_FRACTION = 0.42;

/** What the chip reads when the caller names no kicker. */
const DEFAULT_KICKER = "Logbuch";

const WIDE_PAD = 64;
const POST_PAD = 88;

/** Where the chip sits inside the plate at `linkedin/post`. */
const CHIP_INSET = 48;

const isWide = (placement: Placement) => placement.id === "linkedin/wide";

/**
 * The orientation mark: a green rule and the kicker, on a paper plate.
 *
 * The label is the heading family at 500 while the title is the same family at
 * 400. Both weights are instanced out of the one variable file the Look ships,
 * so the pair is what proves the `wght` axis is honoured rather than the file's
 * default served twice. The plate shrinks to its text, so at `linkedin/post`
 * its measured width is what the Occlusion Zone reports.
 */
function Chip({ kicker, look }: { kicker: string; look: Look }) {
  const c = look.colors;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        alignSelf: "flex-start",
        backgroundColor: c.white,
        paddingLeft: 24,
        paddingRight: 24,
        paddingTop: 16,
        paddingBottom: 16,
      }}
    >
      <div
        style={{
          width: 44,
          height: 4,
          backgroundColor: c.green,
          marginRight: 16,
        }}
      />
      <div
        style={{
          fontFamily: look.headingFamily,
          fontSize: 24,
          fontWeight: 500,
          letterSpacing: 1.5,
          color: c.green,
        }}
      >
        {kicker.toUpperCase()}
      </div>
    </div>
  );
}

function render({ fields, look, placement, image }: TemplateProps<Fields>) {
  const c = look.colors;
  const wide = isWide(placement);
  const kicker = fields.kicker ?? DEFAULT_KICKER;
  const pad = wide ? WIDE_PAD : POST_PAD;
  const box = wide
    ? { width: Math.round(placement.width * PICTURE_FRACTION), height: "100%" }
    : {
        width: placement.width - 2 * POST_PAD,
        height: Math.round(placement.height * PICTURE_FRACTION),
      };

  const type = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        justifyContent: "space-between",
        padding: pad,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        {/* At `linkedin/wide` the chip opens the text column; at
            `linkedin/post` it sits on the band and is an Occlusion Zone. */}
        {wide ? (
          <div style={{ display: "flex", marginBottom: 28 }}>
            <Chip kicker={kicker} look={look} />
          </div>
        ) : null}

        <div
          style={{
            fontFamily: look.headingFamily,
            fontSize: wide ? 62 : 84,
            fontWeight: 400,
            lineHeight: 1.12,
            color: c.black,
          }}
        >
          {fields.title}
        </div>

        {fields.excerpt ? (
          <div
            style={{
              fontFamily: look.bodyFamily,
              fontSize: wide ? 24 : 32,
              fontWeight: 400,
              lineHeight: 1.45,
              color: c.grayDark,
              marginTop: 28,
            }}
          >
            {fields.excerpt}
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 40,
        }}
      >
        <img src={LOGO_SRC} width={LOGO_WIDTH} height={LOGO_HEIGHT} />
        <div
          style={{
            fontFamily: look.bodyFamily,
            fontSize: 22,
            fontWeight: 400,
            color: c.grayMedium,
          }}
        >
          {fields.date ?? ""}
        </div>
      </div>
    </div>
  );

  const picture = (
    <ImageSlot
      src={image.src}
      style={{
        position: "relative",
        // Never shrunk: this box is the Image Slot, and flex would otherwise
        // trade its width away to a long title. A slot that moved with the
        // Fields would make `target` a different size on every call.
        flexShrink: 0,
        // At `linkedin/post` the picture is a plate on the paper field, so the
        // page's own margin runs round it and the slot's origin is the padding
        // rather than the canvas corner. At `linkedin/wide` the sheet is split
        // in two and the column runs to the edge, where a margin would make the
        // picture look pasted on.
        ...(wide
          ? {}
          : {
              marginLeft: POST_PAD,
              marginRight: POST_PAD,
              marginTop: POST_PAD,
            }),
        width: box.width,
        height: box.height,
        backgroundColor: c.greenLight,
      }}
    >
      {wide ? null : (
        <Occludes
          style={{
            position: "absolute",
            left: CHIP_INSET,
            bottom: CHIP_INSET,
          }}
        >
          <Chip kicker={kicker} look={look} />
        </Occludes>
      )}
    </ImageSlot>
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: wide ? "row" : "column",
        width: "100%",
        height: "100%",
        backgroundColor: c.white,
      }}
    >
      {wide ? (
        <>
          {type}
          {picture}
        </>
      ) : (
        <>
          {picture}
          {type}
        </>
      )}
    </div>
  );
}

/**
 * The Subject Area is design intent, not a layout result. Both are in Image
 * Slot fractions, so neither is the Placement's shape: the column is upright
 * and wants the face high and centred, the plate is wide and wants it right of
 * the chip.
 */
const laicaPost: Template<typeof Fields> = {
  id: "laica-post",
  brand: "laica",
  description:
    "laica LinkedIn post announcing one Logbuch article: paper-white field, a green orientation mark, and the hero picture in a column beside the type.",
  fields: Fields,
  placements: ["linkedin/post", "linkedin/wide"],
  subjectArea: {
    "linkedin/post": { x: 0.34, y: 0.08, width: 0.42, height: 0.84 },
    "linkedin/wide": { x: 0.12, y: 0.08, width: 0.76, height: 0.5 },
  },
  example: {
    title: "Wie ein Agent lernt, den eigenen Code zu prüfen",
    kicker: "Logbuch",
    excerpt:
      "Ein Review, das nur den Diff liest, findet die halbe Wahrheit. Was fehlt, ist der Lauf gegen das echte System.",
    date: "6. September 2026",
  },
  render,
};

export default laicaPost;
