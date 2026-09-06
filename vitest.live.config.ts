/**
 * The live suites: real backends, real credentials, out of `pnpm check`.
 * `pnpm test:store:live` and `pnpm test:records:live`, which are separate
 * scripts because the store's polls to Blob's 60 s deletion deadline cost about
 * ten minutes and records' whole run costs under two.
 *
 * They are named `*.live.ts`, not `*.live.test.ts`, so that Vitest's default
 * test glob cannot collect them. Keeping a live suite out of CI is then a
 * property of the file name rather than an exclusion list someone has to
 * remember to extend.
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

/**
 * The credentials come from `vercel env pull .env.local`. Failing here rather
 * than inside a test says which of the two is wrong: the setup or the store.
 *
 * Parsed rather than `process.loadEnvFile`, because that one never overrides a
 * variable already exported in the shell. A stale export then wins silently,
 * and for `RECORDS_DATABASE_URL_UNPOOLED` that means a live suite creating and
 * dropping schemas on whatever database the export names. The file
 * `vercel env pull` just wrote is the authority.
 */
const pulled = parseEnv(readFileSync(".env.local", "utf8"));

/** Forwarded to the workers by name, so no unrelated variable travels with them. */
const FORWARDED = [
  "BLOB_PUBLIC_STORE_ID",
  "BLOB_PRIVATE_STORE_ID",
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_PEOPLE_READ_WRITE_TOKEN",
  "VERCEL_OIDC_TOKEN",
  "RECORDS_DATABASE_URL_UNPOOLED",
] as const;

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.live.ts"],
    env: Object.fromEntries(
      FORWARDED.flatMap((name) => {
        const value = pulled[name];
        return typeof value === "string" ? [[name, value] as const] : [];
      })
    ),
    // The live suite has a budget of two minutes in total; no single call
    // against `fra1` should come near this.
    testTimeout: 30_000,
    // A live suite exists to report what a real backend did, and the default
    // reporter shows a passing file's `console.log` nowhere. Writing straight
    // to stdout is how the measurements reach the person who ran it.
    disableConsoleIntercept: true,
  },
});
