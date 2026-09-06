/**
 * Applying the committed migrations, and counting the ones still pending.
 *
 * The migrations are embedded rather than read from `drizzle/` at runtime: the
 * gateway's runtime image copies `dist/bundle` and nothing else, so there is no
 * folder in the container to read — and `/health` has to count them there too.
 * `drizzle-kit generate` still writes the SQL; `migrations.ts`
 * embeds it and `tests/migrations.test.ts` fails if the two drift.
 */
import { sql } from "drizzle-orm";
import type { DatabaseDriver } from "./database";
import { MIGRATIONS } from "../migrations.generated";

/** Which migrations this database has applied, and what they hashed to. */
const APPLIED = sql.identifier("records_migrations");

const CREATE_APPLIED = sql`create table if not exists ${APPLIED} (
  tag text primary key,
  hash text not null,
  applied_at timestamptz not null default now()
)`;

type AppliedRow = { readonly tag: string; readonly hash: string };

/**
 * The tags this database has applied, or `null` when it has never been
 * migrated. `null` rather than an empty set because the two mean different
 * things to `/health`, and because reading must never create the table: a
 * probe that writes is a probe that can fail a read-only replica.
 */
async function appliedTags(
  driver: DatabaseDriver
): Promise<Map<string, string> | null> {
  const present = await driver.query<{ readonly present: boolean }>(
    sql`select to_regclass('records_migrations') is not null as present`
  );
  if (present[0]?.present !== true) return null;

  const rows = await driver.query<AppliedRow>(
    sql`select tag, hash from ${APPLIED}`
  );
  return new Map(rows.map((row) => [row.tag, row.hash]));
}

/** How many committed migrations this database has not applied. */
export async function pendingMigrations(
  driver: DatabaseDriver
): Promise<number> {
  const applied = await appliedTags(driver);
  if (applied === null) return MIGRATIONS.length;
  return MIGRATIONS.filter((one) => !applied.has(one.tag)).length;
}

/**
 * Applies every committed migration this database has not applied yet, under
 * the migration lock, one transaction per migration. Throws on the first
 * failure: the gateway calls this at boot, and a failed migration is a failed
 * boot.
 */
export async function applyMigrations(
  driver: DatabaseDriver
): Promise<{ readonly applied: number }> {
  return driver.withMigrationLock(async () => {
    await driver.query(CREATE_APPLIED);
    const applied = (await appliedTags(driver)) ?? new Map<string, string>();

    let count = 0;
    for (const migration of MIGRATIONS) {
      const seen = applied.get(migration.tag);
      if (seen !== undefined) {
        if (seen !== migration.hash) {
          // An applied migration is history. Editing one leaves every database
          // that already ran it on a schema no file describes, so this is a
          // refusal and never a re-apply.
          throw new Error(
            `@meco/records: migration ${migration.tag} was applied as ${seen} and is now ${migration.hash}. Add a migration instead of editing one.`
          );
        }
        continue;
      }

      await driver.transaction(async (exec) => {
        for (const statement of migration.statements) {
          await exec(sql.raw(statement));
        }
        await exec(
          sql`insert into ${APPLIED} (tag, hash) values (${migration.tag}, ${migration.hash})`
        );
      });
      count += 1;
    }

    return { applied: count };
  });
}
