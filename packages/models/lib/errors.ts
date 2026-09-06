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
  /** A JSON body that names no https URL: the second body shape, malformed. */
  bad_source: 400,
  unsupported_mime: 415,
  /**
   * The URL in a `{ url }` body did not hand over the bytes: it answered
   * something other than 2xx (an expired Signed URL is the store's 403, a key
   * it does not hold its 404), did not answer at all, or its body broke off.
   * A 502 because the failure is upstream of models and of its caller both.
   */
  source_unfetchable: 502,
  /** A guard against a runaway body, not a photograph bound. */
  too_large: 413,
  /** A session failed to create on this instance; the next request retries. */
  model_unavailable: 503,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** One of the statuses above, as Hono types a status that carries a body. */
export type ErrorStatus = (typeof ERROR_STATUS)[ErrorCode];

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

  get status(): ErrorStatus {
    return ERROR_STATUS[this.code];
  }
}
