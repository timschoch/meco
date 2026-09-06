/**
 * The Call: one request that entered the gateway, with what was asked, what
 * every module answered, how long each Step took, what it cost and what failed.
 *
 * Two rules decide this file
 * ([ADR-0011](../../../docs/adr/0011-records-postgres-rows-counted-deletes-and-a-sweep.md),
 * Q8 and Q9).
 *
 * **A failed Call is a Call.** `status` is `failed`, `error` says which module
 * and why, and the row is written like any other. The webui explains what
 * happened by reading Calls; a failure nobody wrote down is a gap in the
 * Gallery that nothing can explain.
 *
 * **Every shape another module owns crosses as `unknown`.** `request`,
 * `framing`, `matches`, `redactions` and `cost` are stored and returned unread.
 * `matches` holds identify's whole Identification and not the Match list alone,
 * because the webui needs the verdicts too (decision on #162). `steps` and
 * `error` are records' own shapes and are typed here.
 */
import { and, desc, eq } from "drizzle-orm";
import type { DatabaseDriver } from "./database";
import {
  type Keyset,
  type Page,
  decodeCursor,
  olderThan,
  pageOf,
} from "./page";
import { calls } from "./schema";

/** What kind of work the gateway was asked for. Closed. */
export type CallKind = "annotate" | "crop" | "render" | "carousel" | "enrol";

/** How the Call ended. Closed. */
export type CallStatus = "ok" | "failed";

/**
 * One timed part of a Call, named for the module or Model that did it.
 * The gateway builds the list from its own timers plus every entry of models'
 * `Server-Timing` header, prefixed `models.`. "Which modules ran" is read off
 * these and never off a second column.
 */
export interface Step {
  /** `<module>.<verb>`, or `models.<stage>` for a Model's own timing. */
  readonly name: string;
  readonly durMs: number;
}

/** Why a Call failed. Present exactly when `status` is `failed`. */
export interface CallError {
  readonly module: string;
  readonly code: string;
  readonly message: string;
}

/** One request that entered the gateway, as records keeps it. */
export interface Call {
  /** `crypto.randomUUID()`, minted by records. */
  readonly id: string;
  readonly callerId: string;
  readonly brand: string;
  readonly kind: CallKind;
  /**
   * The Content Hash of the Source Image, when the kind had one. Not a foreign
   * key: the Reference Count is Source Holds plus Reference Photos, and a Call
   * that kept a File alive would put an old Call between the Sweep and a
   * stranger's Face Print.
   */
  readonly sourceHash: string | null;
  /** The wire request minus bytes, its Source Reference replaced by `{ hash }`. */
  readonly request: unknown;
  /** frame's Framing, stored as frame defines it. */
  readonly framing: unknown;
  /** identify's whole Identification, stored as identify defines it. */
  readonly matches: unknown;
  /** redact's Redaction Records, stored as redact defines them. */
  readonly redactions: unknown;
  readonly steps: readonly Step[];
  /** Opaque until pricing exists: records stores it and returns it unread. */
  readonly cost: unknown;
  readonly error: CallError | null;
  readonly status: CallStatus;
  /** ISO 8601, as `@meco/store`'s Listing reports its own times. */
  readonly startedAt: string;
  readonly durationMs: number | null;
}

/**
 * A Call to write. Everything a kind does not use is left out rather than
 * filled in: an `annotate` Call has no Framing, and a column records invented a
 * shape for would be one the webui then has to explain.
 */
export interface NewCall {
  readonly callerId: string;
  readonly brand: string;
  readonly kind: CallKind;
  readonly sourceHash?: string | null;
  readonly request?: unknown;
  readonly framing?: unknown;
  readonly matches?: unknown;
  readonly redactions?: unknown;
  readonly steps?: readonly Step[];
  readonly cost?: unknown;
  readonly error?: CallError | null;
  readonly status: CallStatus;
  /** ISO 8601. The database's clock when the gateway gives none. */
  readonly startedAt?: string;
  readonly durationMs?: number | null;
}

/** The Calls list: newest first, one Brand or every Brand, one status or all. */
export interface CallQuery {
  readonly brand?: string;
  /** What `?status=failed` on the Calls list narrows by (decision on #162). */
  readonly status?: CallStatus;
  readonly limit: number;
  /** The `cursor` a previous page returned. Opaque. */
  readonly cursor?: string;
}

export interface Calls {
  /** Writes the Call, failed or not, and returns it as it now stands. */
  record(call: NewCall): Promise<Call>;
  get(id: string): Promise<Call | null>;
  list(query: CallQuery): Promise<Page<Call>>;
}

const KINDS: readonly CallKind[] = [
  "annotate",
  "crop",
  "render",
  "carousel",
  "enrol",
];

const STATUSES: readonly CallStatus[] = ["ok", "failed"];

/**
 * `kind` and `status` are `text` and not a Postgres enum, so the closed set is
 * written down once in TypeScript and checked here. Without this the column
 * takes whatever a caller mistyped, and the Calls list grows a status nothing
 * can render.
 */
function oneOf<Value extends string>(
  allowed: readonly Value[],
  given: string,
  column: string
): Value {
  const found = allowed.find((one) => one === given);
  if (found === undefined) {
    throw new Error(
      `@meco/records: ${given} is no call ${column}. One of ${allowed.join(", ")}.`
    );
  }
  return found;
}

/** The same check, for the Call facts an Output carries on the Gallery. */
export const asCallStatus = (given: string): CallStatus =>
  oneOf(STATUSES, given, "status");

/** A stored row as the seam reports it: the driver's `Date` becomes ISO 8601. */
type CallRow = {
  readonly id: string;
  readonly callerId: string;
  readonly brand: string;
  readonly kind: string;
  readonly sourceHash: string | null;
  readonly request: unknown;
  readonly framing: unknown;
  readonly matches: unknown;
  readonly redactions: unknown;
  readonly steps: unknown;
  readonly cost: unknown;
  readonly error: unknown;
  readonly status: string;
  readonly startedAt: Date;
  readonly durationMs: number | null;
};

const asCall = (row: CallRow): Call => ({
  id: row.id,
  callerId: row.callerId,
  brand: row.brand,
  kind: oneOf(KINDS, row.kind, "kind"),
  sourceHash: row.sourceHash,
  request: row.request,
  framing: row.framing,
  matches: row.matches,
  redactions: row.redactions,
  // A Call has a list of Steps, possibly empty. `null` would make every caller
  // handle "no Steps" twice.
  steps: (row.steps ?? []) as readonly Step[],
  cost: row.cost,
  error: (row.error ?? null) as CallError | null,
  status: oneOf(STATUSES, row.status, "status"),
  startedAt: row.startedAt.toISOString(),
  durationMs: row.durationMs,
});

const keysetOf = (call: Call): Keyset => ({
  at: new Date(call.startedAt),
  tiebreak: call.id,
});

export function callsOver(driver: DatabaseDriver): Calls {
  const { orm } = driver;

  return {
    async record(call) {
      const [row] = await orm
        .insert(calls)
        .values({
          id: crypto.randomUUID(),
          callerId: call.callerId,
          brand: call.brand,
          kind: oneOf(KINDS, call.kind, "kind"),
          sourceHash: call.sourceHash ?? null,
          request: call.request ?? null,
          framing: call.framing ?? null,
          matches: call.matches ?? null,
          redactions: call.redactions ?? null,
          steps: call.steps === undefined ? [] : [...call.steps],
          cost: call.cost ?? null,
          error: call.error ?? null,
          status: oneOf(STATUSES, call.status, "status"),
          // Omitted rather than defaulted to this process's clock, so a Call
          // the gateway did not time is ordered by the same clock as every
          // other row in the database.
          ...(call.startedAt === undefined
            ? {}
            : { startedAt: new Date(call.startedAt) }),
          durationMs: call.durationMs ?? null,
        })
        .returning();
      if (row === undefined) {
        throw new Error(
          `@meco/records: the call for brand ${call.brand} was inserted and nothing came back.`
        );
      }
      return asCall(row);
    },

    async get(id) {
      const [row] = await orm
        .select()
        .from(calls)
        .where(eq(calls.id, id))
        .limit(1);
      return row === undefined ? null : asCall(row);
    },

    async list(query) {
      const narrowed = [
        query.brand === undefined ? undefined : eq(calls.brand, query.brand),
        query.status === undefined
          ? undefined
          : eq(calls.status, oneOf(STATUSES, query.status, "status")),
        query.cursor === undefined
          ? undefined
          : olderThan(calls.startedAt, calls.id, decodeCursor(query.cursor)),
      ].filter((one) => one !== undefined);

      const rows = await orm
        .select()
        .from(calls)
        .where(narrowed.length === 0 ? undefined : and(...narrowed))
        // The id as well as the time, so two Calls the gateway stamped with the
        // same instant still have one order — which is what a cursor needs to
        // be able to point between them.
        .orderBy(desc(calls.startedAt), desc(calls.id))
        .limit(query.limit + 1);

      return pageOf(rows.map(asCall), query.limit, keysetOf);
    },
  };
}
