/**
 * Produce the full demo set: every Template, for all three brands, from real
 * data. Writes into `out/demo/<brand>/` and prints a summary.
 *
 * This is the thing to run before showing meco to anyone.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { slidesToPdf } from "../src/carousel.js";
import { resolvePlacements, type Placement } from "../src/channels.js";
import { loadImages, renderImage } from "../src/render.js";
import { getTemplate } from "../src/templates/registry.js";
import {
  hopeFamilyPosts,
  laicaCarousels,
  laicaPosts,
  products,
  races,
} from "./demo-data.js";

const OUT = resolve(process.cwd(), "out", "demo");

let count = 0;
let failed = 0;
const started = Date.now();

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[äàáâ]/g, "a")
    .replace(/[öòóô]/g, "o")
    .replace(/[üùúû]/g, "u")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

async function render(
  brandDir: string,
  templateId: string,
  data: unknown,
  channels: string[],
  name: string,
): Promise<void> {
  const template = getTemplate(templateId);
  const parsed = template.schema.safeParse(data);
  if (!parsed.success) {
    failed++;
    console.error(`FAIL ${name}: data does not match ${templateId} schema`);
    console.error(JSON.stringify(parsed.error.issues, null, 2).slice(0, 400));
    return;
  }
  const value = parsed.data as never;

  let images;
  try {
    images = await loadImages(template.images(value));
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}: ${(err as Error).message}`);
    return;
  }

  for (const placement of resolvePlacements(channels)) {
    const bytes = await renderImage({
      node: template.build(value, placement),
      brand: template.brand,
      placement,
      images,
    });
    const dir = resolve(OUT, brandDir);
    await mkdir(dir, { recursive: true });
    const file = resolve(dir, `${name}--${placement.id.replace("/", "-")}.png`);
    await writeFile(file, bytes);
    count++;
    console.log(
      `  ${placement.id.padEnd(18)} ${String(placement.width).padStart(4)}x${String(
        placement.height,
      ).padEnd(5)} ${(bytes.length / 1024).toFixed(0).padStart(5)} KB  ${name}`,
    );
  }
}

async function renderCarousel(
  brandDir: string,
  slides: Array<{ template: string; data: Record<string, unknown> }>,
  channel: string,
  name: string,
): Promise<void> {
  const placement = resolvePlacements([channel])[0] as Placement;
  const pages: Buffer[] = [];

  for (const slide of slides) {
    const template = getTemplate(slide.template);
    const parsed = template.schema.safeParse(slide.data);
    if (!parsed.success) {
      failed++;
      console.error(`FAIL ${name}: slide does not match ${slide.template} schema`);
      return;
    }
    const value = parsed.data as never;
    const images = await loadImages(template.images(value));
    pages.push(
      await renderImage({
        node: template.build(value, placement),
        brand: template.brand,
        placement,
        images,
      }),
    );
  }

  const pdf = await slidesToPdf(pages);
  const dir = resolve(OUT, brandDir);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, `${name}.pdf`), pdf);
  // Keep the slides as images too, for Instagram and for eyeballing.
  await Promise.all(
    pages.map((p, i) =>
      writeFile(resolve(dir, `${name}--slide-${String(i + 1).padStart(2, "0")}.png`), p),
    ),
  );
  count += pages.length + 1;
  console.log(
    `  carousel PDF       ${pages.length} pages  ${(pdf.length / 1024).toFixed(0).padStart(5)} KB  ${name}`,
  );
}

// --------------------------------------------------------------------- laica

console.log("\n=== laica — LinkedIn post images (4 posts x 2 placements) ===");
for (const post of laicaPosts) {
  await render(
    "laica",
    "laica-post",
    {
      title: post.title,
      excerpt: post.excerpt,
      date: post.date,
      heroImage: post.heroImage,
      kicker: "Logbuch",
    },
    ["linkedin"],
    slugify(post.slug),
  );
}

console.log("\n=== laica — LinkedIn carousels (4 posts) ===");
for (const carousel of laicaCarousels) {
  await renderCarousel("laica", carousel.slides, "linkedin/post", slugify(carousel.slug));
}

// ---------------------------------------------------------------- hopefamily

console.log("\n=== Hope Family — blog post images (4 posts x 2 placements) ===");
for (const post of hopeFamilyPosts) {
  await render(
    "hopefamily",
    "hopefamily-post",
    {
      title: post.title,
      excerpt: post.excerpt,
      date: post.date,
      headerImage: post.headerImage,
      kicker: "Neuer Blog Post",
    },
    ["instagram"],
    slugify(post.slug),
  );
}

// -------------------------------------------------------------- swisshutless

console.log("\n=== Swiss Hutless — race infographics (6 rounds x 2 placements) ===");
for (const race of races) {
  await render(
    "swisshutless",
    "swisshutless-race",
    race,
    ["instagram"],
    `runde-${String(race.round).padStart(2, "0")}-${slugify(race.circuit)}`,
  );
}

console.log("\n=== Swiss Hutless — product posts ===");
for (const product of products) {
  await render(
    "swisshutless",
    "swisshutless-product",
    { ...product, shop: "shop.swisshutless.com" },
    ["instagram"],
    slugify(product.name),
  );
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n${count} files written to out/demo in ${seconds}s` +
    (failed > 0 ? `, ${failed} FAILED` : ""),
);
if (failed > 0) process.exitCode = 1;
