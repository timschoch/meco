/**
 * What both live suites need from Neon and neither should own: the connection
 * string, and a database of their own to create and drop.
 *
 * Run-scoped is a **database**, not a schema. `drizzle-kit` writes every
 * foreign key as `references "public"."files"(…)`, so tables created in a
 * schema of one's own still point their keys at `public` — at the deployment's
 * rows. Measured 6 Sep 2026 against `meco-records-eu`: the whole People half of
 * the check list failed that way while passing on pglite, whose `public` was
 * the run's own. A database has a `public` of its own, so the same migration
 * SQL means what it says and nothing here can reach the rows the deployment
 * reads.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * `vitest.live.config.ts` forwards this out of `.env.local`, which it parses
 * rather than loads, so a stale shell export cannot point a suite that creates
 * and drops databases at another one.
 */
const DSN = process.env.RECORDS_DATABASE_URL_UNPOOLED;
if (DSN === undefined || DSN === "") {
  throw new Error(
    "@meco/records: RECORDS_DATABASE_URL_UNPOOLED is not set. `vercel env pull .env.local` in this worktree."
  );
}

/** The endpoint the suites reached. Printed, so a wrong one cannot pass unseen. */
export const liveHost = new URL(DSN).host;

/**
 * The same connection string against another database on the same endpoint.
 * Spliced rather than `new URL(…).toString()`, for the reason `verifying`
 * gives: that re-serialises the userinfo it parsed, and a password with a
 * reserved character in it could come back encoded differently.
 */
const inDatabase = (name: string): string => {
  const at = DSN.indexOf("?");
  const base = at === -1 ? DSN : DSN.slice(0, at);
  const query = at === -1 ? "" : DSN.slice(at);
  return `${base.slice(0, base.lastIndexOf("/"))}/${name}${query}`;
};

/** A run's databases: made on demand, all dropped together. */
export interface Scratch {
  /** A new, empty database. Returns the connection string that reaches it. */
  make(): Promise<string>;
  /** How many were made. */
  readonly count: number;
  /** Drops every one of them and lets the admin connection go. */
  dispose(): Promise<void>;
}

export function scratchDatabases(): Scratch {
  const admin = new pg.Pool({ connectionString: DSN, max: 1 });
  const made: string[] = [];

  return {
    async make() {
      // No dashes: an identifier with one has to be quoted everywhere it
      // appears, including in the connection string, where nothing quotes it.
      const name = `records_live_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`create database "${name}"`);
      made.push(name);
      return inDatabase(name);
    },
    get count() {
      return made.length;
    },
    async dispose() {
      for (const name of made) {
        // `force` because a pool that failed to close would otherwise leave the
        // database standing, and a live suite that litters is one nobody reruns.
        await admin.query(`drop database if exists "${name}" with (force)`);
      }
      await admin.end();
    },
  };
}
