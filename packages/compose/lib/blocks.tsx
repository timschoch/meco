import type { ReactElement, ReactNode } from "react";
import type { RgbaImage } from "@takumi-rs/helpers";
import { ImageSlot, Occludes } from "./markers";

/**
 * The building blocks a Template composes, beside the Markers.
 *
 * A Template may import only `@meco/compose/template`, which is the right rule
 * and the reason `hopefamily-story` and `hopefamily-post` were ~90 % the same
 * file. The fix is not to relax the rule but to put what they shared on the
 * other side of it (#116).
 *
 * These are layout, never Look: every colour, family and size is a prop, so a
 * block carries no Brand's palette and a second Brand can use it without
 * inheriting Hope Family's blue.
 */

/**
 * A colour taken off a Look.
 *
 * `undefined` where the Brand names no such colour: `Look.colors` is an open
 * map by decision (see `template.ts`), so the type cannot promise one and a
 * block that demanded a `string` would put a `!` in every Template. An unset
 * colour renders as no colour, which is what the same value did before these
 * blocks existed.
 */
type LookColor = string | undefined;

const FILL = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
} as const;

/**
 * A wash over the whole picture, so type laid on top of it stays readable.
 *
 * Its own component because a scrim is a thing a designer names, and because
 * `PhotoCard` below is the only arrangement of one that ships today: a Template
 * that wants the wash somewhere else places this itself.
 */
export function Scrim({
  gradient,
}: {
  readonly gradient: string;
}): ReactElement {
  return <div style={{ ...FILL, backgroundImage: gradient }} />;
}

/**
 * A photograph filling the frame, with a scrim over it and a padded column of
 * content over that.
 *
 * The Image Slot is the whole card, so the Plan's slot is the Placement and the
 * window frame cuts has the Placement's shape. Children are the column's, laid
 * out top to bottom with the space between them: a wordmark at the top and a
 * block of type at the bottom is what both Hope Family Templates ask for.
 */
export function PhotoCard({
  background,
  src,
  scrim,
  padding,
  columnWidth = "100%",
  children,
}: {
  /** What shows through where the picture does not reach. */
  readonly background: LookColor;
  readonly src?: RgbaImage;
  /** The scrim's gradient. */
  readonly scrim: string;
  readonly padding: number;
  /** How much of the frame the column takes. Less than all of it leaves the rest to the Subject. */
  readonly columnWidth?: string;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: background,
      }}
    >
      <ImageSlot src={src} style={FILL} />

      <Scrim gradient={scrim} />

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: columnWidth,
          height: "100%",
          padding,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** The four colours a {@link TextBlock} paints with, named by their job. */
export interface TextBlockColors {
  /** The rule, the kicker and the date. */
  readonly accent: LookColor;
  readonly title: LookColor;
  readonly excerpt: LookColor;
  /** The line that says where the post lives. */
  readonly meta: LookColor;
}

/**
 * The sizes and spacings a {@link TextBlock} draws at, in canvas pixels.
 *
 * Every number a Template varies between two shapes and nothing else. Not one
 * scale factor: a story's title is 78 px against a feed post's 68, while their
 * excerpts are both 30, so the two do not move together.
 */
export interface TextBlockScale {
  readonly kicker: number;
  readonly title: number;
  readonly excerpt: number;
  /** The date and the home line. */
  readonly meta: number;
  /** The short bar before the kicker, and the gap after it. */
  readonly rule: {
    readonly width: number;
    readonly height: number;
    readonly gap: number;
  };
  /** Below the kicker row, above the excerpt, above the meta row, and after the date. */
  readonly gaps: {
    readonly kicker: number;
    readonly excerpt: number;
    readonly meta: number;
    readonly date: number;
  };
  readonly excerptLineHeight: number;
}

/**
 * The block of type over a picture: a ruled kicker, a title, an excerpt and a
 * line of small print.
 *
 * Wrapped in `Occludes`, because all of it covers the picture and frame is owed
 * the box. One `Occludes` and not four: what frame needs is where the type is,
 * and the column is that; four boxes would be four times the sweep for the same
 * answer.
 */
export function TextBlock({
  fonts,
  colors,
  scale,
  kicker,
  title,
  excerpt,
  date,
  home,
}: {
  readonly fonts: { readonly heading: string; readonly body: string };
  readonly colors: TextBlockColors;
  readonly scale: TextBlockScale;
  /** Already cased by the Template: the block sets type, it does not edit copy. */
  readonly kicker: string;
  readonly title: string;
  readonly excerpt?: string;
  readonly date?: string;
  /** Where the post lives, on every card, so a screenshot still says where it is. */
  readonly home: string;
}): ReactElement {
  return (
    <Occludes style={{ flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: scale.gaps.kicker,
        }}
      >
        <div
          style={{
            width: scale.rule.width,
            height: scale.rule.height,
            backgroundColor: colors.accent,
            marginRight: scale.rule.gap,
          }}
        />
        <div
          style={{
            fontFamily: fonts.body,
            fontSize: scale.kicker,
            fontWeight: 600,
            letterSpacing: 2,
            color: colors.accent,
          }}
        >
          {kicker}
        </div>
      </div>

      <div
        style={{
          fontFamily: fonts.heading,
          fontSize: scale.title,
          fontWeight: 600,
          lineHeight: 1.12,
          color: colors.title,
        }}
      >
        {title}
      </div>

      {excerpt ? (
        <div
          style={{
            fontFamily: fonts.body,
            fontSize: scale.excerpt,
            fontWeight: 400,
            lineHeight: scale.excerptLineHeight,
            color: colors.excerpt,
            marginTop: scale.gaps.excerpt,
          }}
        >
          {excerpt}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginTop: scale.gaps.meta,
        }}
      >
        {date ? (
          <div
            style={{
              fontFamily: fonts.body,
              fontSize: scale.meta,
              color: colors.accent,
              marginRight: scale.gaps.date,
            }}
          >
            {date}
          </div>
        ) : null}
        <div
          style={{
            fontFamily: fonts.body,
            fontSize: scale.meta,
            color: colors.meta,
          }}
        >
          {home}
        </div>
      </div>
    </Occludes>
  );
}
