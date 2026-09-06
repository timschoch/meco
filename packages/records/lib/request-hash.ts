/**
 * The Request Hash: the SHA-256 of the canonical JSON of `{ brand, kind,
 * request }`, with object keys sorted at every depth.
 *
 * It lives in records because records owns the Output it finds, and canonical
 * has to mean one thing
 * ([ADR-0011](../../../docs/adr/0011-records-postgres-rows-counted-deletes-and-a-sweep.md),
 * Q10). The gateway asks `outputs.byRequest` before it runs any module: a hit
 * is a Replay, and the retry costs a row instead of a second inference.
 *
 * The Brand is inside the hash, so two Brands asking the same thing own two
 * Outputs and neither finds the other's by asking again.
 *
 * What records does **not** do is decide what a request is. The gateway hands
 * over the wire body with its Source Reference already replaced by `{ hash }`,
 * so the same photograph named by two URLs is one Request Hash; that
 * substitution is the gateway's, and its spec checks it.
 */
import { createHash } from "node:crypto";
import type { CallKind } from "./calls";

/**
 * The same value with every object's keys in sorted order. Arrays keep theirs —
 * two slides the other way round are another Carousel — and `undefined`
 * properties go, because `JSON.stringify` drops them anyway and a request that
 * spelled one out must hash as the request that left it out.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const held = source[key];
    if (held !== undefined) sorted[key] = canonical(held);
  }
  return sorted;
}

export function requestHash(
  brand: string,
  kind: CallKind,
  request: unknown
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical({ brand, kind, request })))
    .digest("hex");
}
