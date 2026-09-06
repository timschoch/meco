// What `models` sends and receives, as schemas. One copy, parsed by the client
// and typed against by the host, so the two sides cannot drift apart. Nothing
// here may reach the ONNX Runtime, sharp or Hono: the client imports it.
import { z } from "zod";
import { ModelId, MODULE_NAMES, RegionKind } from "@meco/contracts";
import { ERROR_STATUS, type ErrorCode } from "./errors";

/** One Catalogue entry, as `GET /models` lists it. */
export const CatalogueEntry = ModelId.extend({
  /** The Kinds it draws. Empty for an Enricher: it draws no Region of its own. */
  kinds: z.array(RegionKind),
  /** The licence id. The text stays in the repository and in the image. */
  licence: z.string().min(1),
  /** Warm on the instance that answered, never across the deployment. */
  warm: z.boolean(),
});

export type CatalogueEntry = z.infer<typeof CatalogueEntry>;

/** What `GET /health` answers: one instance's liveness, warmth and memory. */
export const ModelsHealth = z.strictObject({
  ok: z.boolean(),
  service: z.enum(MODULE_NAMES),
  /** The running revision: the commit sha where the platform injects one. */
  version: z.string(),
  models: z.array(ModelId.extend({ warm: z.boolean() })),
  onnxruntime: z.string(),
  /** Resident set size in bytes, so a leak or a cold start needs no profiler. */
  rss: z.number(),
});

export type ModelsHealth = z.infer<typeof ModelsHealth>;

/**
 * What a caller may ask of `POST /annotate` beyond the bytes. The client sends
 * these on and parses nothing: the host is the authority on which lists of
 * Models are legal, and answers `bad_models` when one is not. Exported as a
 * schema so a caller that receives these fields over its own wire — the
 * gateway does — can parse them with this one and not a second copy.
 */
export const AnnotateOptions = z.strictObject({
  /** Catalogue names to run. Absent runs every entry, in Catalogue order. */
  models: z.array(z.string()).optional(),
  /**
   * The Content Hash the caller filed the bytes under. Given, the client
   * refuses an Annotation that names another: two hashes of one body agreeing
   * is the cheapest end-to-end proof the wire carried the bytes intact.
   */
  hash: z.string().optional(),
});

export type AnnotateOptions = z.infer<typeof AnnotateOptions>;

/**
 * The body behind every refusal. The codes are read straight off the host's
 * one table, so a code added there and not understood here cannot compile.
 */
export const WireError = z.object({
  error: z.object({
    code: z.enum(Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]]),
    message: z.string(),
  }),
});
