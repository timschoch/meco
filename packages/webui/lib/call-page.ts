/**
 * Everything one Call View needs, read in one place.
 *
 * The Brand Wall is here rather than in the route: a Call of a Brand the Caller
 * does not hold and an id that names no Call are one answer, `null`, so the
 * route has one refusal to render and cannot accidentally give the two cases
 * two different pages.
 */
import type { Call, Caller, Output, Records } from "@meco/records";
import type { Store } from "@meco/store";

export interface CallView {
  readonly call: Call;
  /** The Outputs this Call made, newest first. Usually one. */
  readonly outputs: readonly Output[];
  /** True when the Call made more Outputs than this page shows. */
  readonly moreOutputs: boolean;
}

export async function callView(
  records: Records,
  caller: Caller,
  id: string,
  pageSize: number
): Promise<CallView | null> {
  const call = await records.calls.get(id);
  if (call === null || !caller.brands.includes(call.brand)) return null;

  // The same cap as a Gallery page, for the same reason: the Call View shows
  // whole Renders at their Public URLs and one page must not become 30 MB of
  // them. A Call makes one Output today, so the cap is slack the page reports
  // rather than a limit anything reaches.
  const page = await records.outputs.list({ callId: id, limit: pageSize });
  return { call, outputs: page.rows, moreOutputs: page.cursor !== null };
}

/**
 * How long a Source Thumbnail's Signed URL lives. Long enough for the browser
 * to follow the redirect it was just given, and far under the store's 300
 * second maximum: the URL is minted per request and is meant to be spent at
 * once, so anything longer is only time for a copied URL to still work.
 */
export const SOURCE_URL_SECONDS = 60;

/**
 * Where the Source Thumbnail's redirect points, or `null` for every reason it
 * may not point anywhere: no such Call, not the Caller's Brand, a Call with no
 * Source Image, no Source Hold, or bytes records no longer has a File for.
 *
 * One `null` for all five, because the route answers one page for all five. A
 * refusal that said which would tell a stranger whether an id exists.
 *
 * The Source Hold is asked before the File. That the bytes are there is not
 * that this Brand may see them, and it is `sources` and never `files` that
 * says so (`@meco/records`, `lib/sources.ts`).
 */
export async function sourceUrl(
  records: Records,
  store: Pick<Store, "signedUrl">,
  caller: Caller,
  id: string
): Promise<string | null> {
  const call = await records.calls.get(id);
  if (call === null || !caller.brands.includes(call.brand)) return null;
  if (call.sourceHash === null) return null;

  const held = await records.sources.heldBy(call.brand, call.sourceHash);
  if (!held) return null;

  const file = await records.files.get(call.sourceHash);
  if (file === null) return null;

  return store.signedUrl(file.storeKey, {
    expiresInSeconds: SOURCE_URL_SECONDS,
  });
}
