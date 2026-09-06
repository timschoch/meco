/**
 * What every check in this package needs before it can look at a page: a
 * migrated database, a Caller, and the two readers that turn HTML back into
 * something assertable.
 *
 * The whole suite runs on PGlite and the in-memory store, so no check here
 * reaches Neon or Blob.
 */
import { type Caller, type Records, records } from "@meco/records";
import { pgliteDatabase } from "@meco/records/pglite";
import { memoryStore } from "@meco/store";
import { afterEach } from "vitest";

/**
 * Booting PGlite costs more than Vitest's default five seconds under the load
 * of a full `pnpm check`, hence the timeout every check carries.
 */
export const TIMEOUT = 30_000;

const opened: Records[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((one) => one.close()));
});

/** A migrated database and the one Caller every row below is written by. */
export async function openRecords(): Promise<{ one: Records; caller: Caller }> {
  const one = records({ database: pgliteDatabase(), store: memoryStore() });
  opened.push(one);
  await one.migrate();
  const caller = await one.callers.create({
    name: "test",
    key: "the-key",
    brands: [],
  });
  return { one, caller };
}

/** The same Caller, holding these Brands. What the gateway's lookup returns. */
export const holding = (caller: Caller, ...brands: string[]): Caller => ({
  ...caller,
  brands,
});

/** A Caller stub in the shape the gateway's own lookup has. */
export const always = (caller: Caller | null) => async () => caller;

/** Every `href` the page holds, in the order they appear. */
export const hrefs = (html: string): string[] =>
  [...html.matchAll(/href="([^"]*)"/g)].map((match) =>
    (match[1] ?? "").replaceAll("&amp;", "&")
  );

/** Every `<img src>` the page holds, in the order they appear. */
export const sources = (html: string): string[] =>
  [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map(
    (match) => match[1] ?? ""
  );
