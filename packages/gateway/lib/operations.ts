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
import { templates } from "@meco/compose";
import { PLACEMENTS } from "@meco/compose/placements";
import { type Annotation, Box, type ModelId } from "@meco/contracts";
import type { Identify } from "@meco/identify";
import type { ModelsClient } from "@meco/models";
import type { Caller, Records } from "@meco/records";
import type { Store } from "@meco/store";
import { z } from "zod";
import { annotationOf } from "./annotate";
import { GatewayError } from "./errors";
import { Brand, FramingOptions } from "./inputs";
import {
  addPerson,
  addReferencePhoto,
  erasePerson,
  listPeople,
} from "./people";
import { RenderInput, renderImage } from "./render";
import { SourceReference, resolveSource } from "./source";
import {
  AddSourceInput,
  CreateUploadInput,
  addSource,
  createUpload,
} from "./sources";
import { recorded } from "./trace";

/** The adapters a handler may reach. A module never sees the Caller. */
export interface OperationDeps {
  readonly records: Records;
  readonly store: Store;
  readonly models: ModelsClient | null;
  /** Built over records, the store and the models client by `createApp`. */
  readonly identify: Identify;
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

// --- The table ---------------------------------------------------------------

const notImplemented = (name: string) => async (): Promise<never> => {
  throw new GatewayError(
    "not_implemented",
    `${name} is in the table and its pipeline is not built yet`
  );
};

/** The Annotation as the wire may carry it: no Face Print on any Region. */
const withoutPrints = (annotation: Annotation): Annotation => ({
  ...annotation,
  regions: annotation.regions.map(({ facePrint: _print, ...region }) => region),
});

const define = <I extends z.ZodObject>(operation: Operation<I>): Operation =>
  operation as unknown as Operation;

export const OPERATIONS: readonly Operation[] = [
  define({
    name: "render_image",
    description:
      "Render a Template over a photograph for one Placement and get the Render's URL.",
    method: "POST",
    path: "/render",
    input: RenderInput,
    handler: renderImage,
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
          const annotation = await annotationOf(ctx, brand, resolved, trace);
          const identification = await trace.step("identify.match", () =>
            ctx.identify.match({ annotation, brand })
          );
          trace.matches(identification);
          return { annotation, identification };
        }
      );
      return {
        call: { id: call.id },
        annotation: withoutPrints(result.annotation),
        identification: result.identification,
      };
    },
  }),
  define({
    name: "create_upload",
    description:
      "Get a URL to upload a photograph to, for a file you hold and cannot give a URL for. Take its SHA-256 first; PUT the file to the `url` this answers, then call `add_source` with the `key`.",
    method: "POST",
    path: "/sources/uploads",
    input: CreateUploadInput,
    handler: createUpload,
  }),
  define({
    name: "add_source",
    description:
      "File a photograph you have uploaded and answer its Content Hash, which you then name as `source: { hash }` on any other Operation.",
    method: "POST",
    path: "/sources",
    input: AddSourceInput,
    handler: addSource,
  }),
  define({
    name: "list_templates",
    description:
      "The Templates a Brand offers, with their Fields as JSON Schema. Every Brand of yours when none is named.",
    method: "GET",
    path: "/templates",
    input: z.object({ brand: Brand.optional() }),
    async handler(ctx) {
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
  define({
    name: "add_person",
    description:
      "Create a Person for a Brand. Enrol a Reference Photo of them next; a Person with none is nobody meco can recognise.",
    method: "POST",
    path: "/people",
    input: z.object({
      brand: Brand,
      name: z.string().min(1).describe("What this Brand calls this person."),
    }),
    handler: addPerson,
  }),
  define({
    name: "erase_person",
    description:
      "Erase a Person: the Reference Photos, their Face Prints and their bytes go with the row. Answers what went and the now-empty listing of everything that was theirs.",
    method: "DELETE",
    path: "/people/:id",
    input: z.object({
      brand: Brand,
      id: z.string().min(1).describe("The Person id `add_person` answered."),
    }),
    handler: erasePerson,
  }),
  define({
    name: "add_reference_photo",
    description:
      "Enrol a photograph of a Person so meco can recognise them. Needs the date they consented. A photograph with several faces answers `choose` and the faces to pick from; send it again naming one.",
    method: "POST",
    path: "/people/:id/photos",
    input: z.object({
      brand: Brand,
      id: z.string().min(1).describe("The Person this photograph is of."),
      source: SourceReference,
      consentAt: z
        .string()
        .optional()
        .describe(
          "ISO 8601. When this person agreed to being recognised. Required: an enrolment without one is refused."
        ),
      regionId: z
        .string()
        .optional()
        .describe(
          "Which face, from a previous `choose` answer. Omit for a photograph with one face."
        ),
    }),
    handler: addReferencePhoto,
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
