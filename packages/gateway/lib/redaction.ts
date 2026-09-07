/**
 * The Redaction Policy: four levels, first set wins, an absent level falls to
 * the next one and not to the default (#249).
 *
 * | level | where it lives                       | who sets it            |
 * | ----- | ------------------------------------ | ---------------------- |
 * | 1     | the request                          | the caller, per call   |
 * | 2     | the Template's `redaction`           | the Template's author  |
 * | 3     | the Brand's `redaction` column       | `set_brand_redaction`  |
 * | 4     | `DEFAULT_REDACTION`                  | meco                   |
 *
 * Resolved at the door, when the FramingRequest is built and before frame or
 * redact runs, so one fact reaches every candidate, redact and the Call row.
 * A Crop has no Template and walks request → brand → default.
 *
 * Field by field, not object by object. A level that declares an empty policy
 * has an opinion about nothing, and the field it left out falls through like a
 * level that declared nothing at all — which is what lets a second field join
 * the policy without any level having to restate the first.
 */
import { type Redaction, RedactionDefault } from "@meco/contracts";

/** Which level answered. On the Framing, so a caller can see why. */
export type RedactionLevel = "request" | "template" | "brand" | "default";

/**
 * The policy one output was made under, and the level that decided it.
 *
 * `from` rides on the Framing rather than on the FramingRequest: the
 * FramingRequest is what frame is asked, and where the answer came from is not
 * something frame reads. It is also never part of the Request Hash — the hash
 * covers the request as sent, so a Brand changing its default does not
 * invalidate an Output already made.
 */
export interface ResolvedRedaction extends Redaction {
  readonly from: RedactionLevel;
}

/**
 * meco's own answer, the last rung: strangers are hidden unless somebody says
 * otherwise (ADR-0014, Decision 6). The safe answer is the default one.
 */
export const DEFAULT_REDACTION: Redaction = { blurUnknownFaces: true };

/** The levels above the default, most preferred first. */
export interface RedactionLevels {
  /** What the caller sent on this request. */
  readonly request?: RedactionDefault;
  /** What the Template declares. Never present for a Crop: it has none. */
  readonly template?: RedactionDefault;
  /**
   * What the Brand has set. `unknown` because records stores and returns the
   * column unread, so this is the one place the shape is named again.
   */
  readonly brand?: unknown;
}

/**
 * A Brand's stored policy, or `undefined` when it has set none.
 *
 * A row that is neither is a throw and not a silent fall-through. Only meco
 * writes this column, through an Operation that validates against the same
 * schema, so a value that fails here is meco's bug — and a privacy setting
 * that quietly ignores what it cannot read is exactly the failure ADR-0003
 * records from production.
 */
function brandPolicy(stored: unknown): RedactionDefault | undefined {
  if (stored === undefined || stored === null) return undefined;
  const parsed = RedactionDefault.safeParse(stored);
  if (!parsed.success) {
    throw new Error(
      `@meco/gateway: a Brand's stored redaction policy is not a Redaction Policy: ${JSON.stringify(stored)}`
    );
  }
  return parsed.data;
}

/**
 * Walk the levels for `blurUnknownFaces` and say which one answered.
 *
 * One walk over an ordered list rather than a chain of `??`, so adding a level
 * is adding an entry, and the level named is the one the value came from by
 * construction. A chain would carry the two separately and could have them
 * disagree.
 */
export function resolveRedaction(levels: RedactionLevels): ResolvedRedaction {
  const walk: readonly (readonly [RedactionLevel, RedactionDefault | undefined])[] =
    [
      ["request", levels.request],
      ["template", levels.template],
      ["brand", brandPolicy(levels.brand)],
    ];

  for (const [from, policy] of walk) {
    const blurUnknownFaces = policy?.blurUnknownFaces;
    if (blurUnknownFaces !== undefined) return { blurUnknownFaces, from };
  }
  return { ...DEFAULT_REDACTION, from: "default" };
}
