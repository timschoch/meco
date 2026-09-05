/**
 * Why the host refused or failed, by code. The one table the wire's
 * `{ error: { code, message } }` and its HTTP status are read from; the spec
 * (`docs/specs/models.md`, "The wire") names each input.
 */
export const ERROR_STATUS = {
  empty_body: 400,
  undecodable: 400,
  unknown_model: 400,
  bad_models: 400,
  unsupported_mime: 415,
  /** A guard against a runaway body, not a photograph bound. */
  too_large: 413,
  /** A session failed to create on this instance; the next request retries. */
  model_unavailable: 503,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** Thrown anywhere in the host; the app turns it into the wire's error body. */
export class HostError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostError";
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}
