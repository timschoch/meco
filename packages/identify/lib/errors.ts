/**
 * The one error identify throws, with the reason as a code rather than as
 * prose. A caller switches on the code; the message is for a human reading a
 * log, and says which photograph would have worked.
 */
export type IdentifyErrorCode =
  | "consent_required"
  | "unknown_person"
  | "no_face"
  | "unknown_region"
  | "too_small"
  | "not_a_face"
  | "no_print"
  | "other_model";

export class IdentifyError extends Error {
  readonly code: IdentifyErrorCode;

  constructor(code: IdentifyErrorCode, message: string) {
    super(message);
    this.name = "IdentifyError";
    this.code = code;
  }
}
