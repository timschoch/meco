/**
 * The meco HTTP API.
 *
 * Small on purpose: render a Template at some Placements, stitch Slides into a
 * Carousel, crop a Source Image, and describe what exists so another tool can
 * discover all of it without being told.
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { z } from "zod";

import { BRANDS } from "./brands.js";
import { slidesToPdf } from "./carousel.js";
import { CHANNELS, PLACEMENTS, resolvePlacements } from "./channels.js";
import { CROP_ANCHORS, cropImage, fetchSourceImage } from "./crop.js";
import { loadImages, renderImage, type ImageFormat } from "./render.js";
import { createStorage } from "./storage.js";
import { describeTemplates, getTemplate } from "./templates/registry.js";

const app = new Hono();
const storage = createStorage();

/** Bearer auth, on only when a token is configured. */
const TOKEN = process.env.MECO_TOKEN;

app.use("/v1/*", async (c, next) => {
  if (!TOKEN) return next();
  const header = c.req.header("authorization") ?? "";
  if (header !== `Bearer ${TOKEN}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

app.get("/health", (c) =>
  c.json({ ok: true, storage: storage.kind, templates: describeTemplates().length }),
);

// ---------------------------------------------------------------- discovery

app.get("/v1/templates", (c) => {
  const brand = c.req.query("brand");
  const all = describeTemplates();
  return c.json(brand ? all.filter((t) => t.brand === brand) : all);
});

app.get("/v1/channels", (c) =>
  c.json({
    channels: CHANNELS,
    placements: [...PLACEMENTS.values()],
    note: "Naming a bare channel renders every placement it offers.",
  }),
);

app.get("/v1/brands", (c) =>
  c.json(
    [...BRANDS.values()].map((b) => ({
      id: b.id,
      name: b.name,
      colors: b.colors,
      headingFamily: b.headingFamily,
      bodyFamily: b.bodyFamily,
    })),
  ),
);

// ------------------------------------------------------------------- render

const renderBody = z.object({
  template: z.string(),
  /** Channels and/or placements; a bare channel fans out. */
  channels: z.array(z.string()).min(1),
  data: z.record(z.string(), z.unknown()),
  format: z.enum(["png", "jpeg", "webp"]).default("png"),
  quality: z.number().int().min(1).max(100).optional(),
});

app.post("/v1/render", async (c) => {
  const parsed = renderBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: z.treeifyError(parsed.error) }, 400);
  }
  const body = parsed.data;

  try {
    const template = getTemplate(body.template);
    const dataResult = template.schema.safeParse(body.data);
    if (!dataResult.success) {
      return c.json(
        {
          error: `Data does not match the schema for template "${body.template}"`,
          details: z.treeifyError(dataResult.error),
        },
        400,
      );
    }
    const data = dataResult.data as never;

    const placements = resolvePlacements(body.channels);
    const images = await loadImages(template.images(data));

    const renders = await Promise.all(
      placements.map(async (placement) => {
        const bytes = await renderImage({
          node: template.build(data, placement),
          brand: template.brand,
          placement,
          images,
          format: body.format as ImageFormat,
          ...(body.quality === undefined ? {} : { quality: body.quality }),
        });
        const ext = body.format === "jpeg" ? "jpg" : body.format;
        const stored = await storage.put(
          "renders",
          bytes,
          `image/${body.format}`,
          ext,
        );
        return {
          placement: placement.id,
          width: placement.width,
          height: placement.height,
          ...stored,
        };
      }),
    );

    return c.json({ template: body.template, renders });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// ----------------------------------------------------------------- carousel

const carouselBody = z.object({
  /** Each Slide names its own Template. */
  slides: z
    .array(
      z.object({
        template: z.string(),
        data: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1),
  channel: z.string().default("linkedin/post"),
  /** `pdf` for LinkedIn, `images` for Instagram. */
  output: z.enum(["pdf", "images"]).default("pdf"),
});

app.post("/v1/carousel", async (c) => {
  const parsed = carouselBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: z.treeifyError(parsed.error) }, 400);
  }
  const body = parsed.data;

  try {
    const placements = resolvePlacements([body.channel]);
    const placement = placements[0];
    if (!placement) {
      return c.json({ error: `No placement resolved for "${body.channel}"` }, 400);
    }

    const pages: Buffer[] = [];
    for (const slide of body.slides) {
      const template = getTemplate(slide.template);
      const dataResult = template.schema.safeParse(slide.data);
      if (!dataResult.success) {
        return c.json(
          {
            error: `Slide data does not match schema for "${slide.template}"`,
            details: z.treeifyError(dataResult.error),
          },
          400,
        );
      }
      const data = dataResult.data as never;
      const images = await loadImages(template.images(data));
      pages.push(
        await renderImage({
          node: template.build(data, placement),
          brand: template.brand,
          placement,
          images,
        }),
      );
    }

    if (body.output === "images") {
      const stored = await Promise.all(
        pages.map((p) => storage.put("renders", p, "image/png", "png")),
      );
      return c.json({ placement: placement.id, slides: stored });
    }

    const pdf = await slidesToPdf(pages);
    const stored = await storage.put("carousels", pdf, "application/pdf", "pdf");
    return c.json({ placement: placement.id, pages: pages.length, ...stored });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// --------------------------------------------------------------------- crop

const cropBody = z.object({
  source: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  anchor: z.enum(CROP_ANCHORS).optional(),
  strategy: z.enum(["attention", "entropy"]).optional(),
  format: z.enum(["png", "jpeg", "webp"]).default("jpeg"),
  quality: z.number().int().min(1).max(100).optional(),
});

app.post("/v1/crop", async (c) => {
  const parsed = cropBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: z.treeifyError(parsed.error) }, 400);
  }
  const body = parsed.data;

  try {
    const source = await fetchSourceImage(body.source);
    const result = await cropImage({
      source,
      width: body.width,
      height: body.height,
      ...(body.anchor ? { anchor: body.anchor } : {}),
      ...(body.strategy ? { strategy: body.strategy } : {}),
      format: body.format,
      ...(body.quality === undefined ? {} : { quality: body.quality }),
    });
    const ext = body.format === "jpeg" ? "jpg" : body.format;
    const stored = await storage.put("crops", result.data, result.contentType, ext);
    return c.json({
      width: result.width,
      height: result.height,
      resolvedBy: result.resolvedBy,
      ...(result.anchor ? { anchor: result.anchor } : {}),
      ...stored,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// Serve local renders so the URLs the local driver hands back actually resolve.
app.use("/renders/*", serveStatic({ root: "./out" }));
app.use("/carousels/*", serveStatic({ root: "./out" }));
app.use("/crops/*", serveStatic({ root: "./out" }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`meco listening on :${info.port}  storage=${storage.kind}`);
});

export default app;
