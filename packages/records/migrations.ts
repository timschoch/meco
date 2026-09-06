// Entry point: the generator that keeps the two artefacts of a Migration in
// step. The migrations themselves are the neighbouring `migrations.generated.ts`.
//
// There are two because the gateway's runtime image copies `dist/bundle` and
// nothing else (`Containerfile`), so a container has no `drizzle/` folder to
// read its migrations from — and `/health` has to count the pending ones there
// too. `drizzle-kit generate` writes the SQL, which is the reviewable artefact;
// this module embeds it in `migrations.generated.ts`, which is what runs.
//
// Regenerate both with `pnpm --filter @meco/records migrations`.
// `tests/migrations.test.ts` fails if they drift.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));

/** What drizzle-kit puts between two statements of one migration. */
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/** One migration as it is on disk, before it is embedded. */
export interface SourceMigration {
  readonly tag: string;
  readonly hash: string;
  readonly statements: string[];
}

type JournalEntry = { readonly idx: number; readonly tag: string };

/** Every migration under `drizzle/`, in the order the journal applies them. */
export function readMigrations(root: string = packageRoot): SourceMigration[] {
  const folder = join(root, "drizzle");
  const journal = JSON.parse(
    readFileSync(join(folder, "meta", "_journal.json"), "utf8")
  ) as { readonly entries: JournalEntry[] };

  const tags = [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => entry.tag);

  // A `.sql` the journal does not name would be applied by nothing and
  // reviewed as if it were, which is worse than a missing migration.
  const orphans = readdirSync(folder)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(0, -".sql".length))
    .filter((tag) => !tags.includes(tag));
  if (orphans.length > 0) {
    throw new Error(
      `@meco/records: drizzle/ holds ${orphans.join(", ")}.sql, which the journal does not name.`
    );
  }

  return tags.map((tag) => {
    const sql = readFileSync(join(folder, `${tag}.sql`), "utf8");
    return {
      tag,
      hash: createHash("sha256").update(sql).digest("hex"),
      statements: sql
        .split(STATEMENT_BREAKPOINT)
        .map((statement) => statement.trim())
        .filter((statement) => statement !== ""),
    };
  });
}

/** The text `migrations.generated.ts` must hold for these migrations. */
export function renderModule(migrations: SourceMigration[]): string {
  return `// Generated from drizzle/ by migrations.ts. Do not edit.
//
// The SQL has to travel inside the bundle: the gateway's runtime image copies
// \`dist/bundle\` alone, so there is no folder to read it from. Regenerate with
// \`pnpm --filter @meco/records migrations\`.

/** One committed migration, as \`migrate()\` applies it and \`/health\` counts it. */
export interface EmbeddedMigration {
  /** The file's name without \`.sql\`, and its primary key in the applied table. */
  readonly tag: string;
  /** SHA-256 of the whole file, so an edited migration is a loud failure. */
  readonly hash: string;
  /** The file split on drizzle's statement breakpoints, in order. */
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly EmbeddedMigration[] = ${JSON.stringify(migrations, null, 2)};
`;
}

// Run directly — `node migrations.ts` — to regenerate. Node strips the types.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const migrations = readMigrations();
  writeFileSync(
    join(packageRoot, "migrations.generated.ts"),
    renderModule(migrations)
  );
  console.log(
    `@meco/records: embedded ${migrations.length} migration(s) in migrations.generated.ts`
  );
}
