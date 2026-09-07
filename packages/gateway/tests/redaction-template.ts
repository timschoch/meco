/**
 * Three Templates for one Brand: one declaring `false`, one declaring `true`,
 * and one declaring nothing. They exist so the Template rung of the Redaction
 * Policy can be walked end to end through `createApp().request`, in both
 * directions, against every Brand default (#249).
 *
 * Not shipped. compose's registry holds the Templates a Brand actually
 * publishes, and a Template nobody asked for would show up in `list_templates`
 * in production for the sake of a test. `createApp` takes the registry it
 * plans, draws and lists from, so the suite hands in these two instead.
 *
 * `createElement` and not TSX, so the gateway needs no JSX configuration for
 * one fixture. The tree is the picture and nothing else: what is under test is
 * which level answered, not a layout.
 *
 * `hopefamily` because the test Caller holds it and compose has a Look for it.
 * A Template naming a Brand with no Look is refused before it can be drawn.
 */
import { createElement } from "react";
import {
  ImageSlot,
  type Template,
  type TemplateProps,
} from "@meco/compose/template";
import { z } from "zod";

const Fields = z.strictObject({
  caption: z.string().min(1).max(64),
});

type Fields = z.infer<typeof Fields>;

const render = ({ look, image }: TemplateProps<Fields>) =>
  createElement(
    "div",
    {
      style: {
        display: "flex",
        width: "100%",
        height: "100%",
        backgroundColor: look.colors["white"] ?? "#ffffff",
      },
    },
    createElement(ImageSlot, {
      ...(image.src === undefined ? {} : { src: image.src }),
      style: { position: "relative", width: "100%", height: "100%" },
    })
  );

const base = {
  brand: "hopefamily",
  fields: Fields,
  placements: ["instagram/story"],
  example: { caption: "a caption" },
  render,
} as const;

/** Declares nothing, so the Brand's default answers next. */
export const silentTemplate: Template<typeof Fields> = {
  ...base,
  id: "hopefamily-silent",
  description: "A Template with no opinion about redaction.",
};

/** Declares `false`, so it outranks the Brand and only the request outranks it. */
export const unblurredTemplate: Template<typeof Fields> = {
  ...base,
  id: "hopefamily-unblurred",
  description: "A Template that shows every face, named or not.",
  redaction: { blurUnknownFaces: false },
};

/**
 * Declares `true`, which is also meco's default — and is not the same thing.
 * Over a Brand that set `false`, this Template blurs and the Brand does not,
 * so a rung that only ever declared `false` would leave the Template's
 * precedence proved in one direction and assumed in the other.
 */
export const blurredTemplate: Template<typeof Fields> = {
  ...base,
  id: "hopefamily-blurred",
  description: "A Template that hides every face meco cannot name.",
  redaction: { blurUnknownFaces: true },
};

/** The registry `createApp` is handed: these three and nothing else. */
export const REDACTION_TEMPLATES: ReadonlyMap<string, Template> = new Map<
  string,
  Template
>([
  [silentTemplate.id, silentTemplate],
  [unblurredTemplate.id, unblurredTemplate],
  [blurredTemplate.id, blurredTemplate],
]);
