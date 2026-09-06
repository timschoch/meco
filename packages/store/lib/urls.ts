/**
 * How bytes leave the store. A public object has one address that never
 * expires; a private object has no address at all until the gateway asks for a
 * Signed URL, and that one stops working minutes later.
 *
 * Which of the two a key gets is decided here by the Namespace alone, the same
 * rule `isPrivate` applies everywhere else, so no call site can hand out the
 * wrong kind by asking for it.
 */
import { isPrivate } from "./keys";

/**
 * Five minutes, both the default and the maximum.
 *
 * Vercel caps a delegation at seven days. meco caps at five minutes because the
 * only use is showing one private object to the caller who just asked for it: a
 * URL that outlives the request is a URL that can be forwarded, and a Reference
 * Photo is a biometric record of a real person.
 */
export const MAX_SIGNED_URL_SECONDS = 300;

/**
 * Arithmetic, not a lookup: the store id lowercased with `store_` stripped is
 * the first label of the host, and the key follows verbatim because
 * `addRandomSuffix` is false on every write.
 *
 * That is why `records` stores a Store Key and never a URL — a URL in a column
 * would have gone stale the day the stores were recreated in `fra1`. Verified
 * against the live account on 6 Sep 2026.
 */
export function publicBlobUrl(storeId: string, key: string): string {
  const label = storeId.replace(/^store_/, "").toLowerCase();
  return `https://${label}.public.blob.vercel-storage.com/${key}`;
}

/** A public key has a public URL; a private key has none to give. */
export function assertPublicKey(key: string): void {
  if (isPrivate(key)) {
    throw new Error(
      `@meco/store: "${key}" is a private Store Key and has no public URL. Returning one would be a lie a caller could publish.`
    );
  }
}

/** Only the Private Store's objects are worth signing for. */
export function assertPrivateKey(key: string): void {
  if (!isPrivate(key)) {
    throw new Error(
      `@meco/store: "${key}" is a public Store Key, served at an address that does not expire. Signing it would only shorten a URL meant to last.`
    );
  }
}

/**
 * When a Signed URL stops working, in milliseconds since the epoch.
 *
 * A lifetime is refused rather than clamped: a caller that asked for an hour
 * and silently got five minutes would find out when the link died in front of
 * someone, and one that asked for zero seconds meant something it did not say.
 */
export function validUntilFor(
  expiresInSeconds: number = MAX_SIGNED_URL_SECONDS
): number {
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1) {
    throw new Error(
      `@meco/store: expiresInSeconds ${expiresInSeconds} is no lifetime. A whole number of seconds from 1 to ${MAX_SIGNED_URL_SECONDS}.`
    );
  }
  if (expiresInSeconds > MAX_SIGNED_URL_SECONDS) {
    throw new Error(
      `@meco/store: expiresInSeconds ${expiresInSeconds} is over MAX_SIGNED_URL_SECONDS (${MAX_SIGNED_URL_SECONDS}).`
    );
  }
  return Date.now() + expiresInSeconds * 1000;
}
