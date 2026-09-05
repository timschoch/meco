/**
 * What meco does, with no transport attached.
 *
 * The HTTP routes in `app.ts` and the MCP tools in `mcp.ts` are both thin
 * shells over these three functions, so a Template added once is reachable
 * from both without a second registration.
 */
import { z } from "zod";

import { annotate, faceRegions, facesOf, type Annotated } from "./annotations.js";
import { BRANDS } from "./brands.js";
import { slidesToPdf } from "./carousel.js";
import { PLACEMENTS, resolvePlacements, type PlacementId } from "./channels.js";
import { CROP_ANCHORS, PIN_TO, cropImage, fetchSourceImage } from "./crop.js";
import { FACES_URL, type DetectedFace } from "./faces.js";
import { matchFaces, type Match } from "./people.js";
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

/**
 * True when this request can be answered — it named a Brand, or it asked
 * nothing that needs one.
 *
 * A Person belongs to exactly one Brand, so `persons` and `pinTo: "person"` are
 * both unanswerable without one — and answering them as "nobody matched" would
 * look like the People were wrong rather than the request. Refused at the schema
 * so both surfaces refuse it the same way, and shared by both schemas so they
 * cannot come to disagree about what "needs a Brand" means.
 */
const brandGivenIfNeeded = (body: { brand?: string; pinTo?: string; persons?: string[] }) =>
  body.brand !== undefined || (body.pinTo !== "person" && body.persons === undefined);

const NEEDS_BRAND =
  "Naming Persons, or pinning to a Person, needs the Brand that owns them: send brand.";

export const cropBody = z
  .object({
    source: z.string().url(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** Enables Person matching against this Brand's People. */
    brand: z.string().optional(),
    pinTo: z.enum(PIN_TO).optional(),
    persons: z.array(z.string()).min(1).optional(),
    anchor: z.enum(CROP_ANCHORS).optional(),
    strategy: z.enum(["attention", "entropy"]).optional(),
    subjectArea: subjectAreaShape.optional(),
    blurUnknownFaces: z.boolean().default(false),
    format: z.enum(["png", "jpeg", "webp"]).default("jpeg"),
    quality: z.number().int().min(1).max(100).optional(),
  })
  .refine(brandGivenIfNeeded, { message: NEEDS_BRAND });

export type CropInput = z.infer<typeof cropBody>;

/**
 * One Match, as a caller reads it.
 *
 * The score is rounded, because the fifth decimal of a cosine is noise from the
 * decoder and a caller comparing two answers should not see it move.
 */
const reportMatch = (m: Match) => ({
  personId: m.personId,
  name: m.name,
  score: +m.score.toFixed(4),
});

/**
 * The Matches, as a caller reads them.
 *
 * One entry per matched face, in the order the faces are in — so a photograph
 * where two enrolled People stand side by side names both, and a Crop pinned on
 * one of them still says the other was recognised and left sharp. An unknown
 * face is simply absent: the list is who meco can name, and its length beside
 * the face count is how many it could not.
 */
const reportMatches = (matches: readonly (Match | null)[]) =>
  matches.filter((m): m is Match => m !== null).map(reportMatch);

/**
 * The faces named, when the request named a Brand to name them from.
 *
 * Both `crop` and `findSubjects` do exactly this and then merge the warnings
 * into their own, so it is one function: two copies could come to differ about
 * whether a Brand is optional, or about what a face service outage does, and
 * only one of the two would be tested.
 */
async function matchIfBrand(
  input: { brand?: string; persons?: string[] },
  source: Buffer,
  annotated: Annotated | null,
  faces: readonly DetectedFace[],
  storage: Storage,
) {
  if (!input.brand) return { matches: [], warnings: [], facesNotCompared: 0 };
  return matchFaces(
    {
      brand: input.brand,
      source,
      // The Annotation's size, not the Source Image's own metadata: they are the
      // same number, and taking it from the Annotation means matching judges the
      // frame the faces were found in rather than one it measured itself.
      //
      // Zero when there is no Annotation, and reached rather than short-circuited
      // here. No Annotation means no faces, and `matchFaces` answers from the
      // empty list long before it looks at a size — but it checks the Brand
      // first, and a deployment with no face service must still refuse a Brand
      // that does not exist.
      width: annotated?.annotation.source.width ?? 0,
      height: annotated?.annotation.source.height ?? 0,
      faces,
      ...(input.persons ? { persons: input.persons } : {}),
    },
    storage,
  );
}

export async function crop(input: CropInput, storage: Storage) {
  const source = await fetchSourceImage(input.source);

  // Faces come before any pixel is cut, because they are what the framing is
  // solved from. A deployment with no face service gets `null` and frames itself
  // from its other producers; a face service that failed gets no faces and a
  // warning, which is the difference between "nobody asked" and "we could not".
  const annotated = await annotate(source, storage);
  const faces = annotated ? facesOf(annotated.annotation) : [];

  // Matching needs the Brand, so a Crop without one frames on faces and blurs
  // every one of them — which is what a Crop did before Persons existed.
  const named = await matchIfBrand(input, source, annotated, faces, storage);
  const warnings = [...(annotated?.warnings ?? []), ...named.warnings];

  const result = await cropImage({
    source,
    width: input.width,
    height: input.height,
    ...(faces.length > 0 ? { faces } : {}),
    ...(named.matches.length > 0 ? { matches: named.matches } : {}),
    ...(input.pinTo ? { pinTo: input.pinTo } : {}),
    ...(input.anchor ? { anchor: input.anchor } : {}),
    ...(input.strategy ? { strategy: input.strategy } : {}),
    ...(input.subjectArea ? { subjectArea: input.subjectArea } : {}),
    ...(input.blurUnknownFaces ? { blurUnknownFaces: true } : {}),
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
    ...(result.blurred === undefined ? {} : { blurred: result.blurred }),
    /**
     * How many Uncompared Faces there are — faces meco never compared against
     * this Brand's People, because the face service would not answer or its warp
     * could not read them.
     *
     * **Present whenever a Brand was named, zero and all**, for the same reason
     * `matches` is: a field that comes and goes cannot distinguish "nothing went
     * wrong" from "this deployment does not report it", and distinguishing those
     * is the entire point of issue #39. Omitting it when zero would have
     * reproduced the silence one layer up from the one being fixed.
     *
     * Of the whole photograph and not of the finished frame, deliberately.
     * `blurred` counts what is in the picture because that is what a blur is
     * about; this is about a comparison that happens before any pixel is cut,
     * and scoping it to the window would hide the very case a caller needs.
     */
    ...(input.brand ? { facesNotCompared: named.facesNotCompared } : {}),
    // Always present once a Brand was named, empty list and all: "meco knows
    // these People and recognised none of them here" is an answer, and a caller
    // cannot tell it from "matching never ran" if the field comes and goes.
    ...(input.brand ? { matches: reportMatches(named.matches) } : {}),
    // A Crop that could not reach the face service still succeeds — it simply
    // frames itself from saliency or the Crop Anchor instead. Saying so is the
    // difference between a picture framed on a face and one that only looks as
    // though it was.
    ...(warnings.length > 0 ? { warnings } : {}),
    ...stored,
  };
}

// ----------------------------------------------------------------- subjects

/**
 * What meco can find in a Source Image, without cropping it.
 *
 * The same Annotation a Crop is framed from, handed over on its own so the
 * console can draw the boxes before anyone commits to a shape. Cached under the
 * image's hash like every other lookup, so a preview followed by a Crop of the
 * same photograph costs one detection between them.
 */
export const subjectsBody = z
  .object({
    source: z.string().url(),
    /** Match the faces against this Brand's People as well as finding them. */
    brand: z.string().optional(),
    persons: z.array(z.string()).min(1).optional(),
  })
  .refine(brandGivenIfNeeded, { message: NEEDS_BRAND });

export type SubjectsInput = z.infer<typeof subjectsBody>;

export async function findSubjects(input: SubjectsInput, storage: Storage) {
  const source = await fetchSourceImage(input.source);
  const annotated = await annotate(source, storage);
  if (!annotated) {
    // Not a failure of this request but of the deployment, and the only honest
    // answer: a Crop has other producers to fall back on, `find subjects` has
    // nothing else to be.
    throw new ApiError(
      `Face detection is not configured on this deployment — set ${FACES_URL}. See DEPLOY.md.`,
    );
  }
  // The Annotation itself is never touched. It is filed under the hash of the
  // image alone, and which faces are Matches depends on the Brand that asked —
  // writing a name into it would hand the next Brand somebody else's answer.
  const regions = faceRegions(annotated.annotation);
  const named = await matchIfBrand(
    input,
    source,
    annotated,
    regions.map((r) => r.face),
    storage,
  );
  const warnings = [...annotated.warnings, ...named.warnings];

  return {
    ...annotated.annotation,
    // Keyed by region rather than by position, so the console can colour a box
    // green without counting along two lists and hoping they line up.
    ...(input.brand
      ? {
          matches: named.matches.flatMap((match, i) =>
            match ? [{ regionId: regions[i]!.region.RegionId, ...reportMatch(match) }] : [],
          ),
        }
      : {}),
    // The same count a Crop reports, present on the same terms, and the route
    // where "of the whole photograph" is the only thing it could mean — there is
    // no crop window here at all.
    ...(input.brand ? { facesNotCompared: named.facesNotCompared } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
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

/**
 * The three kinds of stored output. An allowlist rather than "everything in the
 * store", because the store also holds records — a Person, an Annotation — and a
 * record is never in the Gallery. See CONTEXT.md.
 */
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
