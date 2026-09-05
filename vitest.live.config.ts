/**
 * The live suites: real backends, real credentials, out of `pnpm check`.
 * `pnpm test:store:live`.
 *
 * They are named `*.live.ts`, not `*.live.test.ts`, so that Vitest's default
 * test glob cannot collect them. Keeping a live suite out of CI is then a
 * property of the file name rather than an exclusion list someone has to
 * remember to extend.
 */
import { defineConfig } from "vitest/config";

// The credentials come from `vercel env pull .env.local`. Failing here rather
// than inside a test says which of the two is wrong: the setup or the store.
process.loadEnvFile(".env.local");

/** Forwarded to the workers by name, so no unrelated variable travels with them. */
const FORWARDED = [
  "BLOB_PUBLIC_STORE_ID",
  "BLOB_PRIVATE_STORE_ID",
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_PEOPLE_READ_WRITE_TOKEN",
  "VERCEL_OIDC_TOKEN",
] as const;

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.live.ts"],
    env: Object.fromEntries(
      FORWARDED.flatMap((name) => {
        const value = process.env[name];
        return value === undefined ? [] : [[name, value] as const];
      })
    ),
    // The live suite has a budget of two minutes in total; no single call
    // against `fra1` should come near this.
    testTimeout: 30_000,
  },
});
