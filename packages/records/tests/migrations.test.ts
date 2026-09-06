/**
 * The migrations the gateway applies are the migrations `drizzle-kit generate`
 * wrote. They are two artefacts — the SQL under `drizzle/` and the module that
 * embeds it, because the container has no folder to read the SQL from — and two
 * artefacts can drift. This is what stops them.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The generator itself, so the check compares the embedded migrations against
// the same reading `pnpm --filter @meco/records migrations` does, not a second
// one that could be wrong in the same way.
import { MIGRATIONS } from "../migrations.generated";
import { readMigrations } from "../migrations";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the committed migrations", () => {
  it("are embedded exactly as drizzle-kit generated them", () => {
    expect(MIGRATIONS).toEqual(readMigrations(packageRoot));
  });

  it("hold at least the first migration, in journal order", () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(MIGRATIONS[0]?.tag).toBe("0000_the_nine_tables");
    for (const migration of MIGRATIONS) {
      expect(migration.statements.length).toBeGreaterThan(0);
    }
  });
});
