/** Every way compose refuses. Closed, so a caller can branch on the code. */
export const COMPOSE_ERROR_CODES = [
  "unknown_template",
  "unknown_brand",
  "placement_not_supported",
  "invalid_fields",
  "framing_mismatch",
] as const;

export type ComposeErrorCode = (typeof COMPOSE_ERROR_CODES)[number];

/**
 * The one error compose throws. Everything a caller can get wrong has a code;
 * anything else is a bug in compose and stays an ordinary throw.
 */
export class ComposeError extends Error {
  readonly code: ComposeErrorCode;
  /** Whatever the code needs to be acted on, such as zod's issues. */
  readonly detail?: unknown;

  constructor(code: ComposeErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "ComposeError";
    this.code = code;
    this.detail = detail;
  }
}
