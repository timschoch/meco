/**
 * The Output: one Render, Crop or Carousel a Brand owns, and the Gallery that
 * lists them.
 *
 * Two rules decide this file
 * ([ADR-0011](../../../docs/adr/0011-records-postgres-rows-counted-deletes-and-a-sweep.md),
 * Q4 and Q15).
 *
 * **Keyed by `(brand, request_hash)`, and the bytes go only at zero.** The key
 * is what the Replay looks up, so one Output is one request and `record` is
 * idempotent on it. A Store Key is not unique and never was: no Brand appears
 * in a public key (ADR-0010), so two Brands whose Crops come out byte-identical
 * are two rows on one key — and one Brand asking two different things that
 * produce the same bytes is two more (#223). `store.delete` is unconditional:
 * it takes a key and removes the bytes, and it has no idea whether anything
 * still points at them. The count is therefore here and nowhere else — without
 * it, one Brand deleting its Crop would take the other Brand's stable URL with
 * it.
 *
 * **The Gallery is a keyset list.** Newest first, paged over
 * `(created_at, store_key, request_hash)`, each row carrying its Call's `source_hash`,
 * `status` and `started_at` so a tile needs no second read. webui derives URLs
 * with `store.publicUrl(key)`; records returns Store Keys and never a URL.
 */
import type { Store } from "@meco/store";
import { type SQL, and, desc, eq } from "drizzle-orm";
import { type CallStatus, asCallStatus, oneOf } from "./calls";
import type { DatabaseDriver } from "./database";
import {
  type Keyset,
  type Page,
  cursorAt,
  decodeCursor,
  olderThan,
  pageOf,
} from "./page";
import { calls, outputs } from "./schema";

/** What an Output is. Closed, and a subset of a Call's kinds. */
export type OutputKind = "crop" | "render" | "carousel";

/** One Render, Crop or Carousel a Brand owns, with the facts of its Call. */
export interface Output {
  readonly brand: string;
  /** Where the bytes are. Two Brands may name one key; the Gallery may not. */
  readonly storeKey: string;
  readonly callId: string;
  readonly kind: OutputKind;
  /** The Placement it was made for, or `null` for a bare Crop. */
  readonly placement: string | null;
  /** What the same request hashes to, so a retry finds this Output again. */
  readonly requestHash: string;
  /** ISO 8601, as `@meco/store`'s Listing reports its own times. */
  readonly createdAt: string;
  /** Its Call's Source Image, when the kind had one. */
  readonly sourceHash: string | null;
  /** Its Call's status. A Gallery tile says how the Call that made it ended. */
  readonly status: CallStatus;
  /** Its Call's `started_at`. */
  readonly startedAt: string;
}

/**
 * An Output to write. The Call's facts are read back off the Call, and the
 * Request Hash is its key: writing one twice answers the row already there.
 */
export interface NewOutput {
  readonly brand: string;
  readonly storeKey: string;
  readonly callId: string;
  readonly kind: OutputKind;
  readonly placement?: string | null;
  readonly requestHash: string;
}

/** The Gallery query, and the Call View's list of one Call's Outputs. */
export interface OutputQuery {
  readonly brand?: string;
  readonly placement?: string;
  readonly kind?: OutputKind;
  /** One Call's Outputs, for the Call View (decision on #162). */
  readonly callId?: string;
  readonly limit: number;
  /** The `cursor` a previous page returned. Opaque. */
  readonly cursor?: string;
}

/** What `outputs.delete` did. Both are false when there was no such Output. */
export interface OutputDeletion {
  /** False when no such Output: deleting one twice is not an error. */
  readonly deleted: boolean;
  /** Whether the Reference Count reached zero and the bytes went with the row. */
  readonly bytesDeleted: boolean;
}

export interface Outputs {
  record(output: NewOutput): Promise<Output>;
  /** The Replay lookup: the Output an equal request already produced. */
  byRequest(brand: string, requestHash: string): Promise<Output | null>;
  list(query: OutputQuery): Promise<Page<Output>>;
  /** Deletes the row, and the bytes only once no row still names the key. */
  delete(brand: string, storeKey: string): Promise<OutputDeletion>;
}

const KINDS: readonly OutputKind[] = ["crop", "render", "carousel"];

const asOutputKind = (given: string): OutputKind =>
  oneOf(KINDS, given, "output kind");

/**
 * The Output's own columns plus the three its Call carries. One query rather
 * than a read per tile: a Gallery page is twenty of these.
 */
const selection = {
  brand: outputs.brand,
  storeKey: outputs.storeKey,
  callId: outputs.callId,
  kind: outputs.kind,
  placement: outputs.placement,
  requestHash: outputs.requestHash,
  createdAt: outputs.createdAt,
  sourceHash: calls.sourceHash,
  status: calls.status,
  startedAt: calls.startedAt,
  // The sort time as Postgres's own text, for a cursor that must not lose the
  // microseconds a parsed `Date` drops. Read by `list` and ignored elsewhere.
  cursorAt: cursorAt(outputs.createdAt),
};

type OutputRow = {
  readonly brand: string;
  readonly storeKey: string;
  readonly callId: string;
  readonly kind: string;
  readonly placement: string | null;
  readonly requestHash: string;
  readonly createdAt: Date;
  readonly sourceHash: string | null;
  readonly status: string;
  readonly startedAt: Date;
  readonly cursorAt: string;
};

const asOutput = (row: OutputRow): Output => ({
  brand: row.brand,
  storeKey: row.storeKey,
  callId: row.callId,
  kind: asOutputKind(row.kind),
  placement: row.placement,
  requestHash: row.requestHash,
  createdAt: row.createdAt.toISOString(),
  sourceHash: row.sourceHash,
  status: asCallStatus(row.status),
  startedAt: row.startedAt.toISOString(),
});

const keysetOf = (row: OutputRow): Keyset => ({
  at: row.cursorAt,
  // Two of one Brand's Outputs may share a Store Key, so the Request Hash after
  // it is what makes the order total and the cursor a place between two rows.
  tiebreak: [row.storeKey, row.requestHash],
});

export function outputsOver(driver: DatabaseDriver, store: Store): Outputs {
  const { orm } = driver;

  /**
   * Every read goes through here, so the Gallery, the Replay lookup and the row
   * a write hands back are the same shape and the same join.
   */
  const read = (where: SQL | undefined) =>
    orm
      .select(selection)
      .from(outputs)
      // Inner: `call_id` is not null and references a Call, so an Output
      // without one is a row that cannot exist.
      .innerJoin(calls, eq(calls.id, outputs.callId))
      .where(where);

  return {
    async record(output) {
      await orm
        .insert(outputs)
        .values({
          brand: output.brand,
          storeKey: output.storeKey,
          callId: output.callId,
          kind: asOutputKind(output.kind),
          placement: output.placement ?? null,
          requestHash: output.requestHash,
        })
        // The key is the request, so recording one twice is the Output it
        // already made and never an error. The gateway asks `byRequest` first,
        // but two equal requests in flight at once both miss it, and the loser
        // of that race would otherwise be a 500 for a request that has an
        // answer (#223).
        .onConflictDoNothing({
          target: [outputs.brand, outputs.requestHash],
        });
      // Read back rather than `returning()`: the Call's three facts are part of
      // an Output everywhere else, and a write that answered with a narrower
      // shape would be the one place a caller had to handle two. It is also
      // what makes the conflict above answer the row that is there.
      const [row] = await read(
        and(
          eq(outputs.brand, output.brand),
          eq(outputs.requestHash, output.requestHash)
        )
      ).limit(1);
      if (row === undefined) {
        throw new Error(
          `@meco/records: the output ${output.storeKey} reads as missing right after it was recorded.`
        );
      }
      return asOutput(row);
    },

    async byRequest(brand, requestHash) {
      // `(brand, request_hash)` is the primary key, so this is one row or none.
      const [row] = await read(
        and(eq(outputs.brand, brand), eq(outputs.requestHash, requestHash))
      ).limit(1);
      // A miss is `null`. The gateway asks this before every Call, so the
      // ordinary first request must not be an error path.
      return row === undefined ? null : asOutput(row);
    },

    async list(query) {
      const narrowed = [
        query.brand === undefined ? undefined : eq(outputs.brand, query.brand),
        query.placement === undefined
          ? undefined
          : eq(outputs.placement, query.placement),
        query.kind === undefined
          ? undefined
          : eq(outputs.kind, asOutputKind(query.kind)),
        query.callId === undefined
          ? undefined
          : eq(outputs.callId, query.callId),
        query.cursor === undefined
          ? undefined
          : olderThan(
              outputs.createdAt,
              [outputs.storeKey, outputs.requestHash],
              decodeCursor(query.cursor)
            ),
      ].filter((one) => one !== undefined);

      const rows = await read(
        narrowed.length === 0 ? undefined : and(...narrowed)
      )
        // The Store Key and then the Request Hash as well as the time, so two
        // Outputs written in the same microsecond — of one key or of two —
        // still have one order for a cursor to point between.
        .orderBy(
          desc(outputs.createdAt),
          desc(outputs.storeKey),
          desc(outputs.requestHash)
        )
        .limit(query.limit + 1);

      return pageOf(rows, query.limit, asOutput, keysetOf);
    },

    async delete(brand, storeKey) {
      const orphaned = await orm.transaction(async (tx) => {
        const gone = await tx
          .delete(outputs)
          .where(and(eq(outputs.brand, brand), eq(outputs.storeKey, storeKey)))
          .returning({ storeKey: outputs.storeKey });
        if (gone.length === 0) return null;

        // The Reference Count of the key, read after the row is already gone.
        const [named] = await tx
          .select({ brand: outputs.brand })
          .from(outputs)
          .where(eq(outputs.storeKey, storeKey))
          .limit(1);
        return named === undefined;
      });

      if (orphaned === null) return { deleted: false, bytesDeleted: false };
      // After the row commits: the store is not in the transaction, so bytes
      // deleted before a rollback would be bytes a surviving Output still names.
      if (orphaned) await store.delete(storeKey);
      return { deleted: true, bytesDeleted: orphaned };
    },
  };
}
