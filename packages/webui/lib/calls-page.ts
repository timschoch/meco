/**
 * The Calls list's page of Calls: `calls.list` per Brand, merged.
 *
 * `calls.list` would take every Brand at once, and that is exactly why this
 * asks it one Brand at a time: the Caller's Brands are the wall, and a query
 * that did not name one would answer with somebody else's Calls. The merge and
 * its cursor live in `merge.ts`.
 *
 * `status` is records' own filter and is applied in SQL, so a page of failures
 * is a page of failures and not a page thinned out after the fact.
 */
import type { Call, CallStatus, Records } from "@meco/records";
import { type Merged, mergedPage } from "./merge";

export const callsPage = (
  records: Records,
  brands: readonly string[],
  status: CallStatus | undefined,
  pageSize: number,
  cursor: string | undefined
): Promise<Merged<Call>> =>
  mergedPage(
    brands,
    pageSize,
    cursor,
    (brand, from, limit) =>
      records.calls.list({
        brand,
        ...(status === undefined ? {} : { status }),
        ...(from === undefined ? {} : { cursor: from }),
        limit,
      }),
    { brandOf: (call) => call.brand, at: (call) => call.startedAt }
  );
