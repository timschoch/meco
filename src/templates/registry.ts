/**
 * The Template registry.
 *
 * Every Template publishes its own input contract as a Zod schema, and the
 * discovery endpoint turns those into JSON Schema. That is what lets another
 * tool call meco without anyone hand-holding it through each new Template.
 */
import { z } from "zod";
import type { Brand } from "../brands.js";
import { hopefamily, laica, swisshutless } from "../brands.js";
import type { Placement } from "../channels.js";

import { laicaPost, laicaPostImages } from "./laica-post.js";
import { laicaSlide, laicaSlideImages } from "./laica-slide.js";
import { hopeFamilyPost, hopeFamilyPostImages } from "./hopefamily-post.js";
import { swissHutlessRace, swissHutlessRaceImages } from "./swisshutless-race.js";
import {
  swissHutlessProduct,
  swissHutlessProductImages,
} from "./swisshutless-product.js";

export interface Template<T = unknown> {
  id: string;
  brand: Brand;
  description: string;
  schema: z.ZodType<T>;
  /** Build the node tree for one Placement. */
  build: (data: T, placement: Placement) => unknown;
  /** Remote image URLs that must be fetched before rendering. */
  images: (data: T) => string[];
  /** Placements this Template is designed for. Advisory, not enforced. */
  suggestedPlacements: string[];
  /**
   * Real data that renders this Template, so the demo UI and any calling tool
   * can start from something that works instead of from an empty form. Sourced
   * the same way `scripts/demo-data.ts` is — read from the shop, the CMS or the
   * official calendar, never invented.
   */
  example: T;
}

const laicaPostSchema = z.object({
  title: z.string().min(1).describe("Post title, shown large"),
  excerpt: z.string().optional().describe("Short standfirst under the title"),
  date: z.string().optional().describe("Display date, already formatted"),
  heroImage: z.string().url().optional().describe("Absolute URL of the hero image"),
  kicker: z.string().optional().describe("Small label above the title"),
});

const laicaSlideSchema = z.object({
  kind: z.enum(["cover", "point", "quote", "outro"]),
  title: z.string().optional(),
  body: z.string().optional(),
  index: z.number().int().positive().optional(),
  total: z.number().int().positive().optional(),
  kicker: z.string().optional(),
  heroImage: z.string().url().optional(),
  cta: z.string().optional(),
});

const hopeFamilyPostSchema = z.object({
  title: z.string().min(1),
  headerImage: z.string().url().optional().describe("Absolute URL of the post header image"),
  date: z.string().optional(),
  kicker: z.string().optional(),
  excerpt: z.string().optional(),
});

const raceSchema = z.object({
  round: z.number().int().positive().describe("Round number in the season"),
  circuit: z.string().min(1).describe("Official circuit name"),
  location: z.string().min(1).describe("Town and country"),
  date: z.string().min(1).describe("Display date, already formatted"),
  trackImage: z.string().url().optional().describe("Photo or layout map of the circuit"),
  season: z.string().optional(),
  category: z.string().optional(),
});

const productSchema = z.object({
  name: z.string().min(1),
  price: z.string().optional().describe("Exactly as the shop shows it"),
  productImage: z.string().url().optional(),
  specs: z.array(z.string()).max(5).optional(),
  category: z.string().optional(),
  shop: z.string().optional(),
  badge: z.string().optional(),
});

export const TEMPLATES: ReadonlyMap<string, Template<never>> = new Map(
  (
    [
      {
        id: "laica-post",
        brand: laica,
        description: "LinkedIn image announcing one laica Logbuch post",
        schema: laicaPostSchema,
        build: laicaPost,
        images: laicaPostImages,
        suggestedPlacements: ["linkedin/post", "linkedin/wide"],
        example: {
          title: "Viel gelernt bei der Innovationskonferenz",
          excerpt:
            "Letzte Woche durften wir spannende Leute kennenlernen. Und dabei gleich etwas über uns selbst gelernt.",
          date: "26. Juni 2026",
          heroImage: "https://www.laica.dev/api/media/file/Astronaut-pitch.png",
        },
      },
      {
        id: "laica-slide",
        brand: laica,
        description:
          "One slide of a laica LinkedIn carousel; kind picks cover, point, quote or outro",
        schema: laicaSlideSchema,
        build: laicaSlide,
        images: laicaSlideImages,
        suggestedPlacements: ["linkedin/post"],
        example: {
          kind: "cover",
          kicker: "Logbuch",
          title: "Viele kleine Schritte",
          body: "LinkedIn-Outreach läuft, Rücklauf ist dünn. Die spannendste Erkenntnis kam aus den Checks.",
        },
      },
      {
        id: "hopefamily-post",
        brand: hopefamily,
        description: "Hope Family blog post card built around the post header image",
        schema: hopeFamilyPostSchema,
        build: hopeFamilyPost,
        images: hopeFamilyPostImages,
        suggestedPlacements: ["instagram/post", "instagram/story", "facebook/post"],
        example: {
          title: "Eine Woche, die Spuren hinterlässt",
          excerpt:
            "110 Mädchen, eine Woche Sommerlager und ganz viele Geschichten, die bleiben.",
          date: "11.08.2026",
          headerImage:
            "https://images.squarespace-cdn.com/content/v1/68e52c240f55e10baf8c8466/e9e78711-b321-4497-b685-b1ac09b1fcbf/IMG-20260722-WA0008.jpg",
        },
      },
      {
        id: "swisshutless-race",
        brand: swisshutless,
        description: "Swiss Hutless race infographic for one round of the season",
        schema: raceSchema,
        build: swissHutlessRace,
        images: swissHutlessRaceImages,
        suggestedPlacements: ["instagram/post", "instagram/story"],
        example: {
          round: 3,
          circuit: "Circuit de l'Enclos",
          location: "Septfontaines / Levier, Frankreich",
          date: "31. Mai 2026",
          season: "Schweizer Kart Meisterschaft 2026",
          category: "Super Mini / X30 / OK Junior / KZ2",
          trackImage:
            "https://circuitdelenclos.com/upload/contenu/Plan-Aerien-Piste-2018.jpg",
        },
      },
      {
        id: "swisshutless-product",
        brand: swisshutless,
        description: "Swiss Hutless shop product post",
        schema: productSchema,
        build: swissHutlessProduct,
        images: swissHutlessProductImages,
        suggestedPlacements: ["instagram/post", "instagram/story"],
        example: {
          name: 'Kart Mini "Performance"',
          price: "CHF 4'990.00",
          productImage:
            "https://shop.swisshutless.com/shop/resources/product_images_klein/6813_kl.jpg",
          category: "Karts & Chassis / Racing",
          badge: "Ready to drive",
          specs: [
            "Motor: BMB L-X",
            "Reifen: LeCont LMK",
            "Komplett, fahrbereit",
            "Artikel-Nr. 104500",
          ],
        },
      },
    ] as unknown as Template<never>[]
  ).map((t) => [t.id, t]),
);

export function getTemplate(id: string): Template<never> {
  const t = TEMPLATES.get(id);
  if (!t) {
    throw new Error(
      `Unknown template "${id}". Known templates: ${[...TEMPLATES.keys()].join(", ")}.`,
    );
  }
  return t;
}

/** The discovery payload: what a calling tool needs to use meco unaided. */
export function describeTemplates() {
  return [...TEMPLATES.values()].map((t) => ({
    id: t.id,
    brand: t.brand.id,
    description: t.description,
    suggestedPlacements: t.suggestedPlacements,
    schema: z.toJSONSchema(t.schema, { io: "input" }),
    example: t.example,
  }));
}
