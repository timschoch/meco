/**
 * One error shape on both Doors, `{ error: { code, message, details? } }`, and
 * one flat code namespace: the gateway's own codes below, and a module's typed
 * code verbatim (ADR-0014, Decision 6). The status comes from one table, so a
 * code answers with the same status whichever Door it leaves by.
 */
import { ModelsError } from "@meco/models";
import { z } from "zod";

/** The codes the gateway raises itself. */
export const GATEWAY_STATUS = {
  invalid_request: 400,
  unauthorized: 401,
  brand_not_held: 403,
  not_found: 404,
  too_large: 413,
  source_unfetchable: 422,
  resolution_mismatch: 500,
  /** An Operation in the table whose pipeline a later ticket lands. */
  not_implemented: 501,
  models_unavailable: 503,
} as const;

export type GatewayErrorCode = keyof typeof GATEWAY_STATUS;

/**
 * A module's code, verbatim, with the status `docs/specs/gateway.md` gives it.
 * The three models codes that mean "models did not answer" are folded into
 * the gateway's `models_unavailable`, because a caller can do the same thing
 * about all three: try again later.
 */
const MODULE_STATUS: Record<string, number> = {
  // compose
  unknown_template: 404,
  unknown_brand: 404,
  placement_not_supported: 400,
  invalid_fields: 400,
  framing_mismatch: 500,
  // identify
  consent_required: 400,
  unknown_person: 404,
  no_face: 422,
  unknown_region: 422,
  too_small: 422,
  not_a_face: 422,
  no_print: 422,
  other_model: 422,
  // models, through the client
  undecodable: 415,
  unsupported_mime: 415,
  too_large: 413,
  bad_response: 502,
  hash_mismatch: 502,
};

const MODELS_UNAVAILABLE = new Set([
  "unreachable",
  "timeout",
  "model_unavailable",
]);

/**
 * By name, not `instanceof`: importing `ComposeError` from `@meco/compose`
 * would put compose's whole index in the bundle, which cannot load without
 * the Looks' font files beside it (blocker on #181). Each class sets `name`
 * itself, so the check is as exact as the import would be; identify's is
 * read the same way so the two module errors are one branch.
 */
const isModuleError = (
  error: unknown
): error is Error & { readonly code: string } =>
  error instanceof Error &&
  (error.name === "ComposeError" || error.name === "IdentifyError") &&
  typeof (error as { code?: unknown }).code === "string";

/** What a refusal looks like on the wire, whichever Door it leaves by. */
export interface WireError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/**
 * Anything thrown between the Door and the answer, as a status and a body. A
 * throw with no code is a bug, answered as `500 internal` with the message
 * kept off the wire: a stack trace is for the log, not the caller.
 */
export function toWire(error: unknown): { status: number; body: WireError } {
  if (error instanceof GatewayError) {
    return {
      status: GATEWAY_STATUS[error.code],
      body: {
        error:
          error.details === undefined
            ? { code: error.code, message: error.message }
            : {
                code: error.code,
                message: error.message,
                details: error.details,
              },
      },
    };
  }
  if (error instanceof z.ZodError) {
    return {
      status: GATEWAY_STATUS.invalid_request,
      body: {
        error: {
          code: "invalid_request",
          message: "the request does not match the Operation's input",
          details: z.treeifyError(error),
        },
      },
    };
  }
  if (error instanceof ModelsError && MODELS_UNAVAILABLE.has(error.code)) {
    return {
      status: GATEWAY_STATUS.models_unavailable,
      body: { error: { code: "models_unavailable", message: error.message } },
    };
  }
  if (error instanceof ModelsError || isModuleError(error)) {
    return {
      status: MODULE_STATUS[error.code] ?? 500,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  return {
    status: 500,
    body: { error: { code: "internal", message: "the gateway failed" } },
  };
}
