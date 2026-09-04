/**
 * What meco does, with no transport attached.
 *
 * The HTTP routes in `app.ts` and the MCP tools in `mcp.ts` are both thin
 * shells over these three functions, so a Template added once is reachable
 * from both without a second registration.
 */
import { z } from "zod";

import { BRANDS } from "./brands.js";
import { slidesToPdf } from "./carousel.js";
import { PLACEMENTS, resolvePlacements, type PlacementId } from "./channels.js";
import { CROP_ANCHORS, cropImage, fetchSourceImage } from "./crop.js";
import { loadImages, renderImage, type ImageFormat } from "./render.js";
import { isPrivateKey, type Storage } from "./storage.js";
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
      const stored = await storage.put(
        `renders/${template.brand.id}/${placement.id}`,
        bytes,
        `image/${input.format}`,
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
  // A Carousel is filed under the Brand of its first Slide: the whole document
  // belongs to one Brand, and the cover is the Slide that says which.
  let brandId = "";
  for (const slide of input.slides) {
    const { template, data } = parseTemplateData(slide.template, slide.data);
    brandId ||= template.brand.id;
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
      pages.map((p) =>
        storage.put(`renders/${brandId}/${placement.id}`, p, "image/png", "png"),
      ),
    );
    return { placement: placement.id, slides };
  }

  const pdf = await slidesToPdf(pages);
  const stored = await storage.put(
    `carousels/${brandId}/${placement.id}`,
    pdf,
    "application/pdf",
    "pdf",
  );
  return { placement: placement.id, pages: pages.length, ...stored };
}

// --------------------------------------------------------------------- crop

/**
 * The Subject Area as a caller may write it. Shared with the MCP tool schema so
 * both surfaces refuse the same rectangles for the same reasons.
 *
 * Fractions of the output frame, which is why every bound is 0..1 — a Subject
 * Area in pixels would stop meaning the same thing at the next Placement.
 */
export const subjectAreaShape = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
  })
  .refine((a) => a.x + a.width <= 1 && a.y + a.height <= 1, {
    message: "A Subject Area must lie inside the frame: x + width and y + height must not exceed 1.",
  });

export const cropBody = z.object({
  source: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  anchor: z.enum(CROP_ANCHORS).optional(),
  strategy: z.enum(["attention", "entropy"]).optional(),
  subjectArea: subjectAreaShape.optional(),
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
    ...(input.subjectArea ? { subjectArea: input.subjectArea } : {}),
    format: input.format,
    ...(input.quality === undefined ? {} : { quality: input.quality }),
  });
  const ext = input.format === "jpeg" ? "jpg" : input.format;
  const stored = await storage.put("crops", result.data, result.contentType, ext);
  return {
    width: result.width,
    height: result.height,
    resolvedBy: result.resolvedBy,
    satisfied: result.satisfied,
    ...(result.fallback ? { fallback: result.fallback } : {}),
    ...(result.subjectAreaSatisfied === undefined
      ? {}
      : { subjectAreaSatisfied: result.subjectAreaSatisfied }),
    ...(result.anchor ? { anchor: result.anchor } : {}),
    ...stored,
  };
}

// ------------------------------------------------------------------ gallery

/**
 * Everything meco has stored, newest first.
 *
 * Brand and Placement are read off the key rather than kept in an index: `put`
 * files a Render under `renders/<brand>/<channel>/<placement>/…`, so a Brand
 * filter is one prefix listing and a Placement filter is one key comparison.
 * A Crop has neither — it involves no Template and no Placement.
 */
export const galleryQuery = z.object({
  brand: z.string().optional(),
  placement: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(120),
});

export type GalleryInput = z.infer<typeof galleryQuery>;

const KINDS = ["renders", "carousels", "crops"] as const;

export interface GalleryItem {
  key: string;
  url: string;
  bytes: number;
  createdAt: string;
  /** `render`, `carousel` or `crop`. */
  kind: string;
  /** Absent for a Crop, and for anything stored before filing began. */
  brand?: string;
  placement?: string;
}

export async function gallery(input: GalleryInput, storage: Storage) {
  const { brand, placement } = input;
  if (brand && !BRANDS.has(brand)) {
    throw new ApiError(`No such brand: "${brand}"`);
  }
  if (placement && !PLACEMENTS.has(placement as PlacementId)) {
    throw new ApiError(`No such placement: "${placement}"`);
  }

  const listings = await Promise.all(
    KINDS.map(async (kind) => {
      // A Crop carries neither, so any filter at all leaves Crops out.
      if ((brand || placement) && kind === "crops") return [];
      const prefix = brand ? `${kind}/${brand}` : kind;
      const objects = await storage.list(prefix);
      return objects.map((o) => ({ ...o, ...describeKey(o.key) }));
    }),
  );

  const items = listings
    .flat()
    // Reference Photos are personal data and never a stored output. `KINDS`
    // already leaves them out; this is the guard that stays true when a fourth
    // kind is added.
    .filter((i) => !isPrivateKey(i.key))
    .filter((i) => !placement || i.placement === placement)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { total: items.length, items: items.slice(0, input.limit) };
}

/** `renders/laica/instagram/story/3f2a….png` → render, laica, instagram/story. */
function describeKey(key: string): {
  kind: string;
  brand?: string;
  placement?: string;
} {
  const [first, second, third, fourth] = key.split("/");
  const kind = (first ?? "").replace(/s$/, "");
  const brand = second && BRANDS.has(second) ? second : undefined;
  const id = `${third}/${fourth}`;
  const placement = PLACEMENTS.has(id as PlacementId) ? id : undefined;
  return {
    kind,
    ...(brand ? { brand } : {}),
    ...(placement ? { placement } : {}),
  };
}
