/**
 * Everything one Call View needs, read in one place.
 *
 * The Brand Wall is here rather than in the route: a Call of a Brand the Caller
 * does not hold and an id that names no Call are one answer, `null`, so the
 * route has one refusal to render and cannot accidentally give the two cases
 * two different pages.
 */
import type { Call, Caller, Output, Records } from "@meco/records";

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
