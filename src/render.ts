/**
 * Turning a Template plus data plus a Placement into image bytes.
 *
 * The renderer is Takumi: a Rust layout engine with no browser, so a render is
 * tens of milliseconds and the whole service stays a single Node process.
 */
import { readFile } from "node:fs/promises";
import { render as takumiRender } from "takumi-js";
import { googleFonts } from "takumi-js/helpers";
import type { Brand, FontSpec } from "./brands.js";
import type { Placement } from "./channels.js";

export type ImageFormat = "png" | "jpeg" | "webp";

/** An image a Template wants to draw, already fetched. */
export interface LoadedImage {
  src: string;
  data: Uint8Array;
}

/**
 * Fetch every remote image a Template asked for.
 *
 * Takumi will not reach out to the network itself, which is deliberate: the
 * service decides what it is willing to download, and a dead URL fails here
 * with a clear message rather than halfway through layout.
 */
export async function loadImages(
  urls: readonly string[],
): Promise<LoadedImage[]> {
  const unique = [...new Set(urls.filter(Boolean))];

  return Promise.all(
    unique.map(async (url) => {
      if (url.startsWith("data:") || url.startsWith("asset:")) {
        throw new Error(`loadImages only handles http(s) URLs, got: ${url}`);
      }
      const res = await fetch(url, {
        headers: { "user-agent": "meco/0.1 (+social image renderer)" },
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch image ${url}: ${res.status} ${res.statusText}`);
      }
      return { src: url, data: new Uint8Array(await res.arrayBuffer()) };
    }),
  );
}

const localFontCache = new Map<string, Uint8Array>();

async function resolveFonts(specs: readonly FontSpec[]): Promise<unknown[]> {
  const google = specs.filter((f) => f.kind === "google");
  const local = specs.filter((f) => f.kind === "local");

  const localFonts = await Promise.all(
    local.map(async (f) => {
      let bytes = localFontCache.get(f.path);
      if (!bytes) {
        bytes = new Uint8Array(await readFile(f.path));
        localFontCache.set(f.path, bytes);
      }
      return { name: f.name, data: bytes, weight: f.weight };
    }),
  );

  const googleFontList =
    google.length > 0
      ? googleFonts(google.map((f) => ({ name: f.name, weight: f.weight })))
      : [];

  return [...localFonts, ...(await googleFontList)];
}

export interface RenderInput {
  /** The Takumi node tree, usually JSX from a Template. */
  node: unknown;
  brand: Brand;
  placement: Placement;
  images?: LoadedImage[];
  format?: ImageFormat;
  quality?: number;
}

/** Render one Template at one Placement. */
export async function renderImage(input: RenderInput): Promise<Buffer> {
  const { node, brand, placement, images = [], format = "png", quality } = input;

  // Takumi's options type is a discriminated union over `format`, which a
  // runtime-chosen format cannot narrow; the shape is checked by the schema at
  // the API boundary instead.
  const options = {
    width: placement.width,
    height: placement.height,
    format,
    ...(quality === undefined ? {} : { quality }),
    fonts: await resolveFonts(brand.fonts),
    images: images.map((i) => ({ src: i.src, data: i.data })),
  } as never;

  const out = await takumiRender(node as never, options);
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}
