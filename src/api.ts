/**
 * What meco does, with no transport attached.
 *
 * The HTTP routes in `server.ts` and the MCP tools in `mcp.ts` are both thin
 * shells over these three functions, so a Template added once is reachable
 * from both without a second registration.
 */
import { z } from "zod";

import { slidesToPdf } from "./carousel.js";
import { resolvePlacements } from "./channels.js";
import { CROP_ANCHORS, cropImage, fetchSourceImage } from "./crop.js";
import { loadImages, renderImage, type ImageFormat } from "./render.js";
import type { Storage } from "./storage.js";
import { getTemplate } from "./templates/registry.js";

/** A caller mistake — bad template name, data that misses the schema. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Parse against a Template's own schema, reporting the miss the caller made. */
function parseTemplateData(templateId: string, data: unknown) {
  const template = getTemplate(templateId);
  const result = template.schema.safeParse(data);
  if (!result.success) {
    throw new ApiError(
      `Data does not match the schema for template "${templateId}"`,
      z.treeifyError(result.error),
    );
  }
  return { template, data: result.data as never };
}

// ------------------------------------------------------------------- render

export const renderBody = z.object({
  template: z.string(),
  /** Channels and/or placements; a bare channel fans out. */
  channels: z.array(z.string()).min(1),
  data: z.record(z.string(), z.unknown()),
  format: z.enum(["png", "jpeg", "webp"]).default("png"),
  quality: z.number().int().min(1).max(100).optional(),
});

export type RenderInput = z.infer<typeof renderBody>;

export async function render(input: RenderInput, storage: Storage) {
  const { template, data } = parseTemplateData(input.template, input.data);
  const placements = resolvePlacements(input.channels);
  const images = await loadImages(template.images(data));

  const renders = await Promise.all(
    placements.map(async (placement) => {
      const bytes = await renderImage({
        node: template.build(data, placement),
        brand: template.brand,
        placement,
        images,
        format: input.format as ImageFormat,
        ...(input.quality === undefined ? {} : { quality: input.quality }),
      });
      const ext = input.format === "jpeg" ? "jpg" : input.format;
      const stored = await storage.put("renders", bytes, `image/${input.format}`, ext);
      return {
        placement: placement.id,
        width: placement.width,
        height: placement.height,
        ...stored,
      };
    }),
  );

  return { template: input.template, renders };
}

// ----------------------------------------------------------------- carousel

export const carouselBody = z.object({
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

export type CarouselInput = z.infer<typeof carouselBody>;

export async function carousel(input: CarouselInput, storage: Storage) {
  const placement = resolvePlacements([input.channel])[0];
  if (!placement) {
    throw new ApiError(`No placement resolved for "${input.channel}"`);
  }

  const pages: Buffer[] = [];
  for (const slide of input.slides) {
    const { template, data } = parseTemplateData(slide.template, slide.data);
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

  if (input.output === "images") {
    const slides = await Promise.all(
      pages.map((p) => storage.put("renders", p, "image/png", "png")),
    );
    return { placement: placement.id, slides };
  }

  const pdf = await slidesToPdf(pages);
  const stored = await storage.put("carousels", pdf, "application/pdf", "pdf");
  return { placement: placement.id, pages: pages.length, ...stored };
}

// --------------------------------------------------------------------- crop

export const cropBody = z.object({
  source: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  anchor: z.enum(CROP_ANCHORS).optional(),
  strategy: z.enum(["attention", "entropy"]).optional(),
  format: z.enum(["png", "jpeg", "webp"]).default("jpeg"),
  quality: z.number().int().min(1).max(100).optional(),
});

export type CropInput = z.infer<typeof cropBody>;

export async function crop(input: CropInput, storage: Storage) {
  const source = await fetchSourceImage(input.source);
  const result = await cropImage({
    source,
    width: input.width,
    height: input.height,
    ...(input.anchor ? { anchor: input.anchor } : {}),
    ...(input.strategy ? { strategy: input.strategy } : {}),
    format: input.format,
    ...(input.quality === undefined ? {} : { quality: input.quality }),
  });
  const ext = input.format === "jpeg" ? "jpg" : input.format;
  const stored = await storage.put("crops", result.data, result.contentType, ext);
  return {
    width: result.width,
    height: result.height,
    resolvedBy: result.resolvedBy,
    ...(result.anchor ? { anchor: result.anchor } : {}),
    ...stored,
  };
}
