/**
 * The Request Hash: what makes a retry free and a duplicate post impossible.
 *
 * It covers the wire body with the Source Reference replaced by `{ hash }`
 * (ADR-0014, Decision 3), which is the same value the Call row keeps as its
 * `request`. Two URLs of one photograph are therefore one Output, because a
 * URL is an address and not a fact about the output; two posts of one URL are
 * one Output and two Calls.
 */
import { createHash } from "node:crypto";

/**
 * JSON with every object's keys in one order and every `undefined` left out.
 *
 * `JSON.stringify` keeps insertion order, so `{ brand, template }` and
 * `{ template, brand }` — the same request typed in two orders — would hash
 * apart and cost a second render. Sorting is what makes the hash a fact about
 * the request rather than about how it was written.
 */
function canonical(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, one]) => one !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries
    .map(([key, one]) => `${JSON.stringify(key)}:${canonical(one)}`)
    .join(",")}}`;
}

export const requestHash = (request: unknown): string =>
  createHash("sha256").update(canonical(request)).digest("hex");
