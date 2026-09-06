/**
 * Hope Family — a blog post as a full-screen story.
 *
 * The photograph is the whole frame. A blue scrim darkens the top and the
 * bottom and leaves the middle alone, so the wordmark reads above and the type
 * reads below while the picture stays untouched where the Subject sits. Two
 * things cover the picture — the wordmark and the block of type — so there are
 * two `Occludes`.
 *
 * Redrawn against the Template contract, not ported: the prototype's
 * `hopefamily-post.tsx` is evidence for the Look, not a source file. What it got
 * right and is kept: photo-led, the blue scrim, the banana kicker rule. What it
 * could not do and this does: say where the two blocks land before the picture
 * exists.
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
  /** The post's own title. Sentence case, as the blog writes it. */
  title: z.string().min(1).max(80),
  /** The small banana line above it. */
  kicker: z.string().max(32).optional(),
  /** One or two sentences from the post. */
  excerpt: z.string().max(160).optional(),
  /** Already formatted for display, e.g. "6. September 2026". */
  date: z.string().max(32).optional(),
});

type Fields = z.infer<typeof Fields>;

/** What the kicker says when the post does not name one. */
const DEFAULT_KICKER = "Neuer Blogpost";

// The wordmark ships at 900x506; keep that ratio so it never squashes.
const LOGO_WIDTH = 300;
const LOGO_HEIGHT = Math.round((LOGO_WIDTH * 506) / 900);

const PAD = 84;

/** The site, on every card, so a screenshot still says where the post is. */
const HOME = "hope-family.com";

function render({ fields, look, image }: TemplateProps<Fields>) {
  const c = look.colors;

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: c.blue,
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

      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          backgroundImage:
            "linear-gradient(to bottom, rgba(0,80,124,0.80) 0%, rgba(0,80,124,0.30) 20%, rgba(0,80,124,0.08) 40%, rgba(11,18,23,0.78) 72%, rgba(11,18,23,0.96) 100%)",
        }}
      />

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          padding: PAD,
        }}
      >
        <Occludes style={{ width: LOGO_WIDTH, height: LOGO_HEIGHT }}>
          <img src={LOGO_SRC} width={LOGO_WIDTH} height={LOGO_HEIGHT} />
        </Occludes>

        <Occludes style={{ flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              marginBottom: 26,
            }}
          >
            <div
              style={{
                width: 52,
                height: 6,
                backgroundColor: c.banana,
                marginRight: 18,
              }}
            />
            <div
              style={{
                fontFamily: look.bodyFamily,
                fontSize: 28,
                fontWeight: 600,
                letterSpacing: 2,
                color: c.banana,
              }}
            >
              {(fields.kicker ?? DEFAULT_KICKER).toUpperCase()}
            </div>
          </div>

          <div
            style={{
              fontFamily: look.headingFamily,
              fontSize: 78,
              fontWeight: 600,
              lineHeight: 1.12,
              color: c.white,
            }}
          >
            {fields.title}
          </div>

          {fields.excerpt ? (
            <div
              style={{
                fontFamily: look.bodyFamily,
                fontSize: 30,
                fontWeight: 400,
                lineHeight: 1.45,
                color: c.latte,
                marginTop: 24,
              }}
            >
              {fields.excerpt}
            </div>
          ) : null}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              marginTop: 34,
            }}
          >
            {fields.date ? (
              <div
                style={{
                  fontFamily: look.bodyFamily,
                  fontSize: 26,
                  color: c.banana,
                  marginRight: 20,
                }}
              >
                {fields.date}
              </div>
            ) : null}
            <div
              style={{
                fontFamily: look.bodyFamily,
                fontSize: 26,
                color: "rgba(255,255,255,0.75)",
              }}
            >
              {HOME}
            </div>
          </div>
        </Occludes>
      </div>
    </div>
  );
}

/**
 * The Subject Area is design intent, not a layout result: the face belongs in
 * the clear middle band, below the wordmark and above the block of type.
 */
const hopefamilyStory: Template<typeof Fields> = {
  id: "hopefamily-story",
  brand: "hopefamily",
  description:
    "Full-screen Hope Family story: the photograph edge to edge, the wordmark above and one block of type over a blue scrim at the bottom.",
  fields: Fields,
  placements: ["instagram/story", "facebook/story"],
  subjectArea: {
    "instagram/story": { x: 0.08, y: 0.18, width: 0.84, height: 0.44 },
    "facebook/story": { x: 0.08, y: 0.18, width: 0.84, height: 0.44 },
  },
  example: {
    title: "Vier Wochen Vanlife durch Norwegen",
    kicker: "Neuer Blogpost",
    excerpt:
      "Fjorde, Regen und ein Kocher, der nie funktioniert hat — was wir unterwegs gelernt haben.",
    date: "6. September 2026",
  },
  render,
};

export default hopefamilyStory;
