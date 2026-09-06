/**
 * The door's first step: which Caller, if any, is asking.
 *
 * Three ways to carry one key, because three clients cannot all send the same
 * header ([#88](https://github.com/timschoch/meco/issues/88), Q11):
 * `Authorization: Bearer <key>` for an API client, HTTP Basic with the key as
 * the password for a browser opening `/ui` (a navigation cannot set a Bearer
 * header, and the Basic challenge is what makes the browser prompt), and
 * `x-auth-token: <key>` because Claude Desktop's connector dialog greys
 * `Authorization` out.
 *
 * The key is handed to `callers.byKey` whole. Hashing is records' — it holds
 * the SHA-256 and nothing else — so a door that hashed first would look a
 * Caller up by the hash of a hash.
 */
import type { Caller, Records } from "@meco/records";

/** The key a request carries, or `null`. The first form present wins. */
export function keyFrom(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header !== null) {
    const space = header.indexOf(" ");
    if (space === -1) return null;
    const scheme = header.slice(0, space).toLowerCase();
    const credential = header.slice(space + 1).trim();

    if (scheme === "bearer") return credential === "" ? null : credential;
    if (scheme !== "basic") return null;

    // The user name is ignored and the password is the key, so a person can
    // type anything in the first field. A key may itself hold a colon, so only
    // the first one separates.
    const decoded = Buffer.from(credential, "base64").toString("utf8");
    const at = decoded.indexOf(":");
    if (at === -1) return null;
    const password = decoded.slice(at + 1);
    return password === "" ? null : password;
  }

  const token = request.headers.get("x-auth-token");
  return token === null || token === "" ? null : token;
}

/**
 * The `caller(request)` every door shares, and the one webui is handed. A
 * request with no key and a request with a key no Caller holds are the same
 * answer: `null`, and the route decides what that costs.
 */
export function callerLookup(
  records: Records
): (request: Request) => Promise<Caller | null> {
  return async (request) => {
    const key = keyFrom(request);
    if (key === null) return null;
    return records.callers.byKey(key);
  };
}
