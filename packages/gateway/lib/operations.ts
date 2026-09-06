/**
 * The Operation table. Every Operation is one entry here, and nothing is
 * written twice: the HTTP router registers one route per entry with
 * `input.parse` on the body or query, and the MCP factory registers one tool
 * per entry with the same `input` as its schema (ADR-0014, Decision 1).
 *
 * `run` is the one path from a Door to a handler: the Brand Wall, then parse,
 * then the handler. The wall stands first on purpose, so a Caller learns
 * nothing about an input shape for a Brand it does not hold, and a test on
 * #181 proves it by watching for a module that must not have run.
 */
import { PLACEMENTS } from "@meco/compose/placements";
import { Box, CropAnchor, type ModelId, PinTo } from "@meco/contracts";
import type { ModelsClient } from "@meco/models";
import type { Caller, Records } from "@meco/records";
import type { Store } from "@meco/store";
import { z } from "zod";
import { annotationOf, withoutPrints } from "./annotate";
import { GatewayError } from "./errors";
import { resolveSource } from "./source";
import { recorded } from "./trace";

/** The adapters a handler may reach. A module never sees the Caller. */
export interface OperationDeps {
  readonly records: Records;
  readonly store: Store;
  readonly models: ModelsClient | null;
  /** Fetches a `{ url }` Source Reference. */
  readonly fetch: typeof fetch;
  /** The `{ name, version }` pairs a cached Annotation must be complete for. */
  catalogue(): Promise<readonly ModelId[]>;
  /** The clock a Call's `startedAt` is read from. */
  now(): Date;
}

export interface OperationContext extends OperationDeps {
  readonly caller: Caller;
  /**
   * The Brands this request may touch: the one it named, once the wall let
   * it through, or every Brand the Caller holds when it named none.
   */
  readonly brands: readonly string[];
}

export interface Operation<I extends z.ZodObject = z.ZodObject> {
  /** The tool name on the MCP Door. */
  readonly name: string;
  readonly description: string;
  /** The HTTP face, under `/v1`. */
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  /** One object: the body or query is parsed with it and `tools/list` shows it. */
  readonly input: I;
  /**
   * Always an object: the MCP Door carries it as `structuredContent`, which
   * the protocol types as an object, so a list answers `{ items }` on both
   * Doors rather than a bare array on one (decided on #181).
   */
  handler(
    ctx: OperationContext,
    input: z.output<I>
  ): Promise<Record<string, unknown>>;
}

// --- Shared input pieces ----------------------------------------------------

const Brand = z.string().min(1).describe("The Brand this request is for.");

/** How a request names a Source Image: by URL, or by a Content Hash it already sent. */
const SourceReference = z.union([
  z.object({
    url: z
      .url({ protocol: /^https$/ })
      .describe("An https URL the gateway fetches and files."),
  }),
  z.object({
    hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("The Content Hash of bytes this Brand already sent."),
  }),
]);

/** What `render` and `crop` share. Every field optional at the door. */
const FramingOptions = {
  pinTo: z
    .array(PinTo)
    .min(1)
    .optional()
    .describe(
      "The ladder frame walks to find the Subject. Default match, face, kart."
    ),
  persons: z
    .array(z.string().min(1))
    .optional()
    .describe("Person ids that may lead."),
  anchor: CropAnchor.optional(),
  redaction: z
    .object({
      blurUnknownFaces: z
        .boolean()
        .optional()
        .describe("Hide every face meco cannot name. Default true."),
    })
    .optional(),
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  quality: z.int().min(1).max(100).optional(),
};

// --- The table ---------------------------------------------------------------

/**
 * compose, loaded on first use rather than at boot: its index carries `sharp`
 * and `@takumi-rs/core`, which the gateway image does not hold until #183
 * (blocker on #181). An image without them answers a typed 503 on the one
 * route that needs them and serves everything else; the suite reaches the
 * real compose either way.
 */
async function compose(): Promise<typeof import("@meco/compose")> {
  try {
    return await import("@meco/compose");
  } catch (cause) {
    throw new GatewayError(
      "module_unavailable",
      "compose is not in this image yet (#183)",
      undefined,
      { cause }
    );
  }
}

const notImplemented = (name: string) => async (): Promise<never> => {
  throw new GatewayError(
    "not_implemented",
    `${name} is in the table and its pipeline is not built yet`
  );
};

/** People with their Reference Photos as the wire may carry them: no print, no Store Key. */
const listPeople = async (ctx: OperationContext) => {
  const perBrand = await Promise.all(
    ctx.brands.map((brand) => ctx.records.people.list(brand))
  );
  const items = perBrand.flat().map((person) => ({
    id: person.id,
    brand: person.brand,
    name: person.name,
    createdAt: person.createdAt,
    photos: person.photos.map((photo) => ({
      id: photo.id,
      hash: photo.hash,
      regionId: photo.regionId,
      consentAt: photo.consentAt,
      createdAt: photo.createdAt,
    })),
  }));
  return { items };
};

const define = <I extends z.ZodObject>(operation: Operation<I>): Operation =>
  operation as unknown as Operation;

export const OPERATIONS: readonly Operation[] = [
  define({
    name: "render_image",
    description:
      "Render a Template over a photograph for one Placement and get the Render's URL.",
    method: "POST",
    path: "/render",
    input: z.object({
      brand: Brand,
      template: z.string().min(1),
      placement: z.string().min(1),
      fields: z.record(z.string(), z.unknown()),
      source: SourceReference,
      ...FramingOptions,
    }),
    handler: notImplemented("render_image"),
  }),
  define({
    name: "crop_image",
    description:
      "Cut a photograph to a size, framed on its Subject, with no Template.",
    method: "POST",
    path: "/crop",
    input: z.object({
      brand: Brand,
      source: SourceReference,
      width: z.int().positive(),
      height: z.int().positive(),
      subjectArea: Box.optional(),
      ...FramingOptions,
    }),
    handler: notImplemented("crop_image"),
  }),
  define({
    name: "find_subjects",
    description:
      "Say what is in a photograph and who, for this Brand, before rendering.",
    method: "POST",
    path: "/annotate",
    input: z.object({ brand: Brand, source: SourceReference }),
    async handler(ctx, { brand, source }) {
      const { call, result } = await recorded(
        ctx,
        ctx.caller,
        brand,
        "annotate",
        async (trace) => {
          const resolved = await resolveSource(ctx, brand, source, trace);
          trace.sourceHash(resolved.hash);
          trace.request({ brand, source: { hash: resolved.hash } });
          return annotationOf(ctx, brand, resolved, trace);
        }
      );
      // `identification` arrives with the render ticket (#183), which wires
      // identify in; until then the Call's `matches` stays empty.
      return { call: { id: call.id }, annotation: withoutPrints(result) };
    },
  }),
  define({
    name: "list_templates",
    description:
      "The Templates a Brand offers, with their Fields as JSON Schema. Every Brand of yours when none is named.",
    method: "GET",
    path: "/templates",
    input: z.object({ brand: Brand.optional() }),
    async handler(ctx) {
      const { templates } = await compose();
      const items = ctx.brands
        .flatMap((brand) => templates(brand))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { items };
    },
  }),
  define({
    name: "list_placements",
    description: "The output sizes meco knows, one per Channel.",
    method: "GET",
    path: "/placements",
    input: z.object({}),
    handler: async () => ({ items: PLACEMENTS }),
  }),
  define({
    name: "list_brands",
    description: "The Brands your key holds.",
    method: "GET",
    path: "/brands",
    input: z.object({}),
    async handler(ctx) {
      const rows = await Promise.all(
        ctx.brands.map((id) => ctx.records.brands.get(id))
      );
      // By id, as `brands.list` orders, so two keys holding the same Brands
      // see the same list.
      const items = ctx.brands
        .map((id, i) => ({ id, name: rows[i]?.name ?? id }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { items };
    },
  }),
  define({
    name: "list_people",
    description:
      "The People a Brand enrolled, with their Reference Photo ids and consent dates. Every Brand of yours when none is named.",
    method: "GET",
    path: "/people",
    input: z.object({ brand: Brand.optional() }),
    handler: listPeople,
  }),
];

// --- The wall and the one path through it ------------------------------------

/**
 * The Brand Wall. A named Brand the Caller does not hold is refused; a named
 * Brand it holds is the one Brand this request may touch; no Brand means
 * every Brand the Caller holds. Reads the raw input, before the schema: a
 * `brand` that is not a string is no Brand named, and the schema says so next.
 */
function heldBrands(caller: Caller, raw: unknown): readonly string[] {
  const named =
    typeof raw === "object" && raw !== null
      ? (raw as { brand?: unknown }).brand
      : undefined;
  if (typeof named !== "string") return caller.brands;
  if (!caller.brands.includes(named)) {
    throw new GatewayError(
      "brand_not_held",
      `this key does not hold the brand ${named}`
    );
  }
  return [named];
}

/** One Operation, from the raw input a Door received to what it answers. */
export async function run(
  operation: Operation,
  deps: OperationDeps,
  caller: Caller,
  raw: unknown
): Promise<unknown> {
  const brands = heldBrands(caller, raw);
  const input = operation.input.parse(raw);
  return operation.handler({ ...deps, caller, brands }, input);
}
