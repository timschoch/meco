/**
 * Everything one Call View needs, read in one place.
 *
 * The Brand Wall is here rather than in the route: a Call of a Brand the Caller
 * does not hold and an id that names no Call are one answer, `null`, so the
 * route has one refusal to render and cannot accidentally give the two cases
 * two different pages.
 *
 * `framing`, `matches` and `redactions` are shapes other modules own, which
 * records stores and returns unread (`@meco/records`, `lib/calls.ts`). They are
 * read structurally here and never by importing frame, identify or redact:
 * webui runs against whatever some earlier build wrote into those columns, so
 * a shape it cannot read is a section printed as it stands rather than a page
 * that throws.
 */
import type { Annotation, Box } from "@meco/contracts";
import type { Call, Caller, FileRecord, Output, Records } from "@meco/records";
import type { Store } from "@meco/store";

type Region = Annotation["regions"][number];

/** One Region as the Overlay draws it: its box in source fractions, and a word. */
export interface OverlayRegion {
  readonly id: string;
  readonly kind: string;
  /** The Person's name on a Match, `hidden` when redacted, else the Region id. */
  readonly label: string;
  readonly hidden: boolean;
  readonly box: Box;
}

/** What is drawn over the Source Thumbnail. Fractions throughout. */
export interface Overlay {
  readonly regions: readonly OverlayRegion[];
  /** The Crop Window in source fractions, or `null` when none was framed. */
  readonly window: Box | null;
}

/** One face and what identify said about it, as the page lists them. */
export interface FaceVerdictRow {
  readonly regionId: string;
  readonly verdict: string;
  readonly personId?: string;
  readonly similarity?: number;
}

/** One face redact hid, with the reason it gave. */
export interface RedactionRow {
  readonly regionId: string;
  readonly reason: string;
}

export interface CallView {
  readonly call: Call;
  /** The Source Image's File, for the Overlay's own arithmetic. */
  readonly file: FileRecord | null;
  readonly overlay: Overlay | null;
  /** `null` when `matches` is not identify's shape: the page prints it raw. */
  readonly faces: readonly FaceVerdictRow[] | null;
  /** `null` when `redactions` is not redact's shape: the page prints it raw. */
  readonly redactions: readonly RedactionRow[] | null;
  /** The Person names this Call's Matches point at, by Person id. */
  readonly names: ReadonlyMap<string, string>;
  /** The Outputs this Call made, newest first. Usually one. */
  readonly outputs: readonly Output[];
  /** True when the Call made more Outputs than this page shows. */
  readonly moreOutputs: boolean;
  /** The Output a Replay answered with. `null` for every other Call. */
  readonly replayed: Output | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isString = (value: unknown): value is string => typeof value === "string";

/** The Crop Window as frame writes it: whole Source Image pixels. */
type PixelWindow = { x: number; y: number; width: number; height: number };

function pixelWindowOf(framing: unknown): PixelWindow | null {
  if (!isObject(framing) || !isObject(framing["window"])) return null;
  const { x, y, width, height } = framing["window"];
  if (!isNumber(x) || !isNumber(y) || !isNumber(width) || !isNumber(height)) {
    return null;
  }
  return { x, y, width, height };
}

/**
 * The Crop Window over the Source Thumbnail, as a fraction of the picture the
 * page is showing.
 *
 * Divided by the **File's** own width and height, which is the size of the
 * bytes the thumbnail is. The Target — how big the output was asked to be — is
 * a different rectangle entirely, and dividing by it would draw a window that
 * agrees with no image on the page.
 *
 * `windowFraction` is beside `window` in frame's Framing and says the same
 * thing, but it is another module's arithmetic over a size that need not be
 * this File's. The division here is against what the browser is drawing.
 */
const windowFraction = (window: PixelWindow, file: FileRecord): Box => ({
  x: window.x / file.width,
  y: window.y / file.height,
  width: window.width / file.width,
  height: window.height / file.height,
});

/** Which Person each matched Region is, off identify's Match list. */
function matchedPersons(matches: unknown): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  if (!isObject(matches) || !Array.isArray(matches["matches"])) return found;
  for (const one of matches["matches"]) {
    if (!isObject(one)) continue;
    const { regionId, personId } = one;
    if (isString(regionId) && isString(personId)) found.set(regionId, personId);
  }
  return found;
}

/** identify's Face Verdicts, or `null` when this is not that shape. */
export function faceVerdictsOf(
  matches: unknown
): readonly FaceVerdictRow[] | null {
  if (!isObject(matches) || !Array.isArray(matches["faces"])) return null;
  const rows: FaceVerdictRow[] = [];
  for (const one of matches["faces"]) {
    if (!isObject(one)) return null;
    const { regionId, verdict, personId, similarity } = one;
    if (!isString(regionId) || !isString(verdict)) return null;
    rows.push({
      regionId,
      verdict,
      ...(isString(personId) ? { personId } : {}),
      ...(isNumber(similarity) ? { similarity } : {}),
    });
  }
  return rows;
}

/** redact's Redaction Records, or `null` when this is not that shape. */
export function redactionsOf(value: unknown): readonly RedactionRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: RedactionRow[] = [];
  for (const one of value) {
    if (!isObject(one)) return null;
    const { regionId, reason } = one;
    if (!isString(regionId) || !isString(reason)) return null;
    rows.push({ regionId, reason });
  }
  return rows;
}

/** What one Region is called on the Overlay. Name, then `hidden`, then its id. */
const labelOf = (
  region: Region,
  name: string | undefined,
  hidden: boolean
): string => name ?? (hidden ? "hidden" : region.id);

/**
 * How long a Source Thumbnail's Signed URL lives. Long enough for the browser
 * to follow the redirect it was just given, and far under the store's 300
 * second maximum: the URL is minted per request and is meant to be spent at
 * once, so anything longer is only time for a copied URL to still work.
 */
export const SOURCE_URL_SECONDS = 60;

/** The Step a Replay records, and the only Step it records. */
const REPLAY_STEP = "records.replay";

const isReplay = (call: Call): boolean =>
  call.steps.length === 1 && call.steps[0]?.name === REPLAY_STEP;

/**
 * The Output a Replay answered with.
 *
 * A Replay records its own Call and no Output: an Output is keyed
 * `(brand, store_key)`, so the row stays on the Call that first made it. The
 * link back is therefore the Request Hash — the same lookup the gateway did to
 * decide this was a Replay in the first place.
 */
async function replayedOutput(
  records: Records,
  call: Call
): Promise<Output | null> {
  if (!isReplay(call) || call.request === null) return null;
  const hash = records.requestHash(call.brand, call.kind, call.request);
  return records.outputs.byRequest(call.brand, hash);
}

export async function callView(
  records: Records,
  caller: Caller,
  id: string,
  pageSize: number
): Promise<CallView | null> {
  const call = await records.calls.get(id);
  if (call === null || !caller.brands.includes(call.brand)) return null;

  const [file, annotation] = await Promise.all([
    call.sourceHash === null ? null : records.files.get(call.sourceHash),
    call.sourceHash === null ? null : records.annotations.get(call.sourceHash),
  ]);

  // The same cap as a Gallery page, for the same reason: the Call View shows
  // whole Renders at their Public URLs and one page must not become 30 MB of
  // them. A Call makes one Output today, so the cap is slack the page reports
  // rather than a limit anything reaches.
  const page = await records.outputs.list({ callId: id, limit: pageSize });
  const replayed = await replayedOutput(records, call);

  const persons = matchedPersons(call.matches);
  const found = await Promise.all(
    [...new Set(persons.values())].map((personId) =>
      records.people.get(call.brand, personId)
    )
  );
  const names = new Map(
    found.filter((one) => one !== null).map((one) => [one.id, one.name])
  );

  const hidden = new Set(
    (redactionsOf(call.redactions) ?? []).map((one) => one.regionId)
  );
  const window = pixelWindowOf(call.framing);
  const regions = (annotation?.regions ?? []).map((region) => ({
    id: region.id,
    kind: region.kind,
    label: labelOf(
      region,
      names.get(persons.get(region.id) ?? ""),
      hidden.has(region.id)
    ),
    hidden: hidden.has(region.id),
    box: region.box,
  }));

  return {
    call,
    file,
    overlay:
      file === null || (regions.length === 0 && window === null)
        ? null
        : {
            regions,
            window: window === null ? null : windowFraction(window, file),
          },
    faces: faceVerdictsOf(call.matches),
    redactions: redactionsOf(call.redactions),
    names,
    outputs: page.rows,
    moreOutputs: page.cursor !== null,
    replayed,
  };
}

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
