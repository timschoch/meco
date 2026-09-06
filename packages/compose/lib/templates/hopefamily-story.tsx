/**
 * Hope Family — a blog post as a full-screen story.
 *
 * The photograph is the whole frame. A blue scrim darkens the top and the
 * bottom and leaves the middle alone, so the wordmark reads at one end and the
 * type at the other while the picture stays untouched where the Subject sits.
 * Two things cover the picture — the wordmark and the block of type — so there
 * are two `Occludes`.
 *
 * Two Variants: `caption-bottom`, the design, with the wordmark above the
 * type; and `caption-top`, the two swapped and the scrim turned over, for a
 * Subject that sits low in a full-height column (#228). The Look is the same.
 *
 * Redrawn against the Template contract, not ported: the prototype's
 * `hopefamily-post.tsx` is evidence for the Look, not a source file. What it got
 * right and is kept: photo-led, the blue scrim, the banana kicker rule. What it
 * could not do and this does: say where the two blocks land before the picture
 * exists.
 */
import { z } from "zod";
import {
  LOGO_SRC,
  Occludes,
  PhotoCard,
  TextBlock,
  type Template,
  type TemplateProps,
  type TextBlockScale,
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

/** The scrim's stops, written for the wordmark above the type; turned over for the other Variant. */
const STOPS =
  "rgba(0,80,124,0.80) 0%, rgba(0,80,124,0.30) 20%, rgba(0,80,124,0.08) 40%, rgba(11,18,23,0.78) 72%, rgba(11,18,23,0.96) 100%";

/** A story is read at arm's length on a phone: the largest type the Brand sets. */
const SCALE: TextBlockScale = {
  kicker: 28,
  title: 78,
  excerpt: 30,
  meta: 26,
  rule: { width: 52, height: 6, gap: 18 },
  gaps: { kicker: 26, excerpt: 24, meta: 34, date: 20 },
  excerptLineHeight: 1.45,
};

function render({ fields, look, image, variant }: TemplateProps<Fields>) {
  const c = look.colors;
  const top = variant === "caption-top";

  const wordmark = (
    <Occludes style={{ width: LOGO_WIDTH, height: LOGO_HEIGHT }}>
      <img src={LOGO_SRC} width={LOGO_WIDTH} height={LOGO_HEIGHT} />
    </Occludes>
  );
  const type = (
    <TextBlock
      fonts={{ heading: look.headingFamily, body: look.bodyFamily }}
      colors={{
        accent: c.banana,
        title: c.white,
        excerpt: c.latte,
        meta: "rgba(255,255,255,0.75)",
      }}
      scale={SCALE}
      kicker={(fields.kicker ?? DEFAULT_KICKER).toUpperCase()}
      title={fields.title}
      excerpt={fields.excerpt}
      date={fields.date}
      home={HOME}
    />
  );

  return (
    <PhotoCard
      background={c.blue}
      src={image.src}
      scrim={`linear-gradient(to ${top ? "top" : "bottom"}, ${STOPS})`}
      padding={PAD}
    >
      {top ? type : wordmark}
      {top ? wordmark : type}
    </PhotoCard>
  );
}

/**
 * The clear band under each Variant: below the wordmark and above the type,
 * or below the type and above the wordmark. The same box at both story
 * Placements, which are the same size.
 */
const UNDER_THE_WORDMARK = { x: 0.08, y: 0.18, width: 0.84, height: 0.44 };
const UNDER_THE_TYPE = { x: 0.08, y: 0.38, width: 0.84, height: 0.44 };

/**
 * The Subject Area is design intent, not a layout result: the face belongs in
 * the clear middle band, so each Variant declares where that band is.
 */
const hopefamilyStory: Template<typeof Fields> = {
  id: "hopefamily-story",
  brand: "hopefamily",
  description:
    "Full-screen Hope Family story: the photograph edge to edge, the wordmark above and one block of type over a blue scrim at the bottom, or the two swapped when the Subject sits low.",
  fields: Fields,
  placements: ["instagram/story", "facebook/story"],
  variants: [
    {
      name: "caption-bottom",
      subjectArea: {
        "instagram/story": UNDER_THE_WORDMARK,
        "facebook/story": UNDER_THE_WORDMARK,
      },
    },
    {
      name: "caption-top",
      subjectArea: {
        "instagram/story": UNDER_THE_TYPE,
        "facebook/story": UNDER_THE_TYPE,
      },
    },
  ],
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
