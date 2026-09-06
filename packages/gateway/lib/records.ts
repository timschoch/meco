/**
 * How the container gets a `Records`: from one environment variable, or not at
 * all. The gateway never builds a connection string and never names a second
 * one — Vercel injects sixteen `RECORDS_*` variables and records reads this one
 * (`docs/specs/records.md`).
 */
import { type Records, neonDatabase, records } from "@meco/records";
import { blobStore } from "@meco/store";

/**
 * The direct connection string, never the pooled one. The container holds its
 * own pool, and the migration takes a session-level advisory lock that
 * PgBouncer's transaction mode would not keep.
 */
export const CONNECTION_STRING_VAR = "RECORDS_DATABASE_URL_UNPOOLED";

/**
 * The Retention Window in days. How long a stranger's face is kept is a
 * data-protection decision the owner makes, so it is configuration and never a
 * number in a build; unset, records applies its documented default of thirty
 * days. A value that is no number reaches records as `NaN` and fails the boot
 * by its own guard, which is the right noise: a typo here silently keeps a
 * face longer than the owner meant.
 */
export const RETENTION_DAYS_VAR = "RECORDS_RETENTION_DAYS";

/**
 * A `Records` for this process, or `null` when the database is not configured.
 * `null` is a deployment that reports `records.configured: false` on `/health`
 * rather than one that fails to boot: a gateway with no database is still a
 * gateway that can say so.
 */
export function openRecords(
  env: NodeJS.ProcessEnv = process.env
): Records | null {
  const connectionString = env[CONNECTION_STRING_VAR];
  if (connectionString === undefined || connectionString === "") return null;

  const retentionDays = env[RETENTION_DAYS_VAR];

  return records({
    database: neonDatabase(connectionString),
    // records deletes bytes through the store and never reads one.
    store: blobStore({ env }),
    retentionDays:
      retentionDays === undefined || retentionDays === ""
        ? undefined
        : Number(retentionDays),
  });
}
