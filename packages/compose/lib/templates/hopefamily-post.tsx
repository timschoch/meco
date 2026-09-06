/**
 * Hope Family — a blog post as a feed post.
 *
 * The same card as `hopefamily-story` at the two shapes a feed asks for, and
 * the reason it is a second Template rather than two more Placements on the
 * first: 1200x630 is wider than it is tall, so a block of type across the
 * bottom would leave a face nowhere to go. Wide, the type is a column down the
 * left and the Subject Area is the clear right-hand side; tall, it is a block
 * at the bottom and the Subject Area is the band above it.
 *
 * The scrim turns with the layout — top-to-bottom when the type is at the
 * bottom, left-to-right when it is at the left — so the picture stays untouched
 * wherever the Subject Area is.
 *
 * Redrawn against the Template contract, not ported. The prototype's
 * `hopefamily-post.tsx` scaled one bottom-block layout by aspect ratio and put
 * the type over the middle of a wide frame; this does not.
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
  /** One or two sentences from the post. Shorter than the story's: a feed post has less room. */
  excerpt: z.string().max(120).optional(),
  /** Already formatted for display, e.g. "6. September 2026". */
  date: z.string().max(32).optional(),
});

type Fields = z.infer<typeof Fields>;

/** What the kicker says when the post does not name one. */
const DEFAULT_KICKER = "Neuer Blogpost";

/** The site, on every card, so a screenshot still says where the post is. */
const HOME = "hope-family.com";

/** The wordmark ships at 900x506. */
const LOGO_RATIO = 506 / 900;

/** What both shapes set type at, whichever way the frame runs. */
const RHYTHM = {
  rule: { width: 40, height: 5, gap: 14 },
  gaps: { kicker: 20, excerpt: 18, meta: 26, date: 16 },
  excerptLineHeight: 1.4,
} as const;

/**
 * The two shapes this Template draws. Read off the Placement, never off the
 * picture: the Plan is measured before any picture exists, so a Template that
 * sized itself to the bytes would plan one thing and render another.
 */
const SHAPES = {
  wide: {
    pad: 56,
    logoWidth: 220,
    /** The type stays in a column so the other side of the frame is the Subject's. */
    columnWidth: "58%",
    scrim:
      "linear-gradient(to right, rgba(11,18,23,0.94) 0%, rgba(0,80,124,0.74) 44%, rgba(0,80,124,0.20) 76%, rgba(0,80,124,0.06) 100%)",
    scale: {
      ...RHYTHM,
      kicker: 22,
      title: 52,
      excerpt: 24,
      meta: 20,
    } satisfies TextBlockScale,
  },
  tall: {
    pad: 76,
    logoWidth: 280,
    columnWidth: "100%",
    scrim:
      "linear-gradient(to bottom, rgba(0,80,124,0.80) 0%, rgba(0,80,124,0.28) 20%, rgba(0,80,124,0.08) 40%, rgba(11,18,23,0.80) 74%, rgba(11,18,23,0.96) 100%)",
    scale: {
      ...RHYTHM,
      kicker: 26,
      title: 68,
      excerpt: 30,
      meta: 24,
    } satisfies TextBlockScale,
  },
} as const;

function render({ fields, look, placement, image }: TemplateProps<Fields>) {
  const c = look.colors;
  const shape = placement.width > placement.height ? SHAPES.wide : SHAPES.tall;
  const logoHeight = Math.round(shape.logoWidth * LOGO_RATIO);

  return (
    <PhotoCard
      background={c.blue}
      src={image.src}
      scrim={shape.scrim}
      padding={shape.pad}
      columnWidth={shape.columnWidth}
    >
      <Occludes style={{ width: shape.logoWidth, height: logoHeight }}>
        <img src={LOGO_SRC} width={shape.logoWidth} height={logoHeight} />
      </Occludes>

      <TextBlock
        fonts={{ heading: look.headingFamily, body: look.bodyFamily }}
        colors={{
          accent: c.banana,
          title: c.white,
          excerpt: c.latte,
          meta: "rgba(255,255,255,0.75)",
        }}
        scale={shape.scale}
        kicker={(fields.kicker ?? DEFAULT_KICKER).toUpperCase()}
        title={fields.title}
        excerpt={fields.excerpt}
        date={fields.date}
        home={HOME}
      />
    </PhotoCard>
  );
}

/**
 * The Subject Area is design intent, not a layout result. Tall, the face
 * belongs in the band between the wordmark and the block of type; wide, on the
 * side of the frame the type column does not reach.
 */
const hopefamilyPost: Template<typeof Fields> = {
  id: "hopefamily-post",
  brand: "hopefamily",
  description:
    "Hope Family feed post: the photograph edge to edge with the type in a block at the bottom, or in a left-hand column where the frame is wider than it is tall.",
  fields: Fields,
  placements: ["instagram/post", "facebook/post"],
  subjectArea: {
    "instagram/post": { x: 0.08, y: 0.2, width: 0.84, height: 0.34 },
    "facebook/post": { x: 0.62, y: 0.08, width: 0.32, height: 0.84 },
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

export default hopefamilyPost;
