/**
 * The Sweep: the periodic delete of Files nobody holds any more.
 *
 * A stranger who walked through somebody's photograph never agreed to
 * anything, and their Face Print sits in the cached Annotation of those bytes.
 * ADR-0011 keeps that print for exactly as long as some Brand holds the
 * photograph, and this file is what makes that finite: a File with no Source
 * Hold and no Reference Photo, older than the Retention Window, goes with its
 * Annotation and its bytes.
 *
 * Two questions, and they are not the same question.
 *
 * **The Reference Count of a File** is its rows in `sources` plus its rows in
 * `reference_photos`, and nothing else. `calls.source_hash` names a File
 * without referencing it on purpose, so an old Call can never keep one alive.
 * It decides whether the row goes.
 *
 * **The rows naming a Store Key** decide whether the bytes go. `store.delete`
 * is unconditional (ADR-0010), so the counting is here, and it is the same
 * rule `people.unenrol` applies to a Reference Photo's key.
 */
import type { Store } from "@meco/store";
import { and, inArray, lt } from "drizzle-orm";
import type { DatabaseDriver } from "./database";
import { unreferencedFileClauses } from "./references";
import { files, outputs } from "./schema";

/** What one Sweep removed, and what it measured the Retention Window by. */
export interface SweepReport {
  /** The instant the window was measured from. ISO 8601. */
  readonly sweptAt: string;
  /** The Retention Window in days, as configured. */
  readonly retentionDays: number;
  /** The Content Hashes whose File and Annotation went. */
  readonly files: readonly string[];
  /** The Store Keys whose bytes were deleted, in order. */
  readonly keys: readonly string[];
}

/**
 * Thirty days, the value `docs/specs/records.md` names and the one a
 * deployment that sets nothing gets. It is a default and not the window: the
 * window is `retentionDays`, because changing how long a stranger's face is
 * kept is a data-protection decision and must not be a code change.
 */
export const DEFAULT_RETENTION_DAYS = 30;

/** Exported for the Conformance Checks, which move the clock by whole days. */
export const DAY_MS = 86_400_000;

export function sweeping(
  driver: DatabaseDriver,
  store: Store,
  retentionDays: number
): (now?: Date) => Promise<SweepReport> {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error(
      `@meco/records: retentionDays is ${retentionDays}, which is no Retention Window.`
    );
  }
  const { orm } = driver;

  return async function sweep(now = new Date()): Promise<SweepReport> {
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

    const removed = await orm.transaction(async (tx) => {
      const orphans = await tx
        .select({ hash: files.hash, storeKey: files.storeKey })
        .from(files)
        // Ordered on the hash so a report reads the same twice, and so two
        // adapters cannot differ in what a caller may rely on.
        .orderBy(files.hash)
        .where(
          and(lt(files.firstSeenAt, cutoff), ...unreferencedFileClauses(tx))
        );
      if (orphans.length === 0) return { files: [], keys: [] };

      const hashes = orphans.map((one) => one.hash);
      // The Annotation goes by cascade, which is where a stranger's Face Print
      // actually lives.
      await tx.delete(files).where(inArray(files.hash, hashes));

      const keys = [...new Set(orphans.map((one) => one.storeKey))];
      const named = await tx
        .selectDistinct({ storeKey: outputs.storeKey })
        .from(outputs)
        .where(inArray(outputs.storeKey, keys));
      const byAnOutput = new Set(named.map((one) => one.storeKey));

      return {
        files: hashes,
        keys: keys.filter((key) => !byAnOutput.has(key)),
      };
    });

    // After the rows commit: the store is not in the transaction, so bytes
    // deleted before a rollback would be bytes a surviving row still names.
    for (const key of removed.keys) await store.delete(key);

    return {
      sweptAt: now.toISOString(),
      retentionDays,
      files: removed.files,
      keys: removed.keys,
    };
  };
}
