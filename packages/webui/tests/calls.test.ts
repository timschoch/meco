import { type Caller, type Records, records } from "@meco/records";
import { pgliteDatabase } from "@meco/records/pglite";
import { memoryStore } from "@meco/store";
import { afterEach, describe, expect, it } from "vitest";
import { webui } from "../index";

/**
 * The Calls list, on PGlite and the in-memory store like the rest of the suite.
 * Booting PGlite costs more than Vitest's default five seconds under the load
 * of a full `pnpm check`, hence the timeouts.
 */
const TIMEOUT = 30_000;

const opened: Records[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((one) => one.close()));
});

/** A migrated database and the one Caller every Call below is written by. */
async function openRecords(): Promise<{ one: Records; caller: Caller }> {
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
const holding = (caller: Caller, ...brands: string[]): Caller => ({
  ...caller,
  brands,
});

/** A Caller stub in the shape the gateway's own lookup has. */
const always = (caller: Caller | null) => async () => caller;

/**
 * A second apart, so the order of two Calls is a fact and not the toss-up a
 * shared millisecond makes of it: pglite's clock is millisecond-resolution and
 * records breaks a tie on the id, which is a random UUID.
 */
const at = (second: number): string =>
  new Date(Date.UTC(2026, 8, 6, 10, 0, second)).toISOString();

/**
 * One Call, written through records' own methods so the list is asserted
 * against real rows and the real cursor rather than a stub. A failed Call
 * carries the error records requires of one.
 */
async function writeCall(
  one: Records,
  callerId: string,
  what: {
    brand: string;
    kind?: "annotate" | "crop" | "render" | "carousel" | "enrol";
    status?: "ok" | "failed";
    code?: string;
    durationMs?: number;
    startedAt?: string;
  }
): Promise<string> {
  const status = what.status ?? "ok";
  const call = await one.calls.record({
    callerId,
    brand: what.brand,
    kind: what.kind ?? "render",
    status,
    durationMs: what.durationMs ?? 12,
    ...(what.startedAt === undefined ? {} : { startedAt: what.startedAt }),
    error:
      status === "failed"
        ? {
            module: "frame",
            code: what.code ?? "no_subject",
            message: "nothing to frame",
          }
        : null,
  });
  return call.id;
}

/** Every `href` the page holds, in the order they appear. */
const hrefs = (html: string): string[] =>
  [...html.matchAll(/href="([^"]*)"/g)].map((match) =>
    (match[1] ?? "").replaceAll("&amp;", "&")
  );

/** The Call ids the page lists, in the order it lists them. */
const listed = (basePath: string, html: string): string[] =>
  hrefs(html)
    .filter((href) => href.startsWith(`${basePath}/calls/`))
    .map((href) => href.slice(`${basePath}/calls/`.length));

describe("the Calls list", () => {
  it(
    "lists the Caller's Calls newest first, each row linking its Call View",
    async () => {
      const { one, caller } = await openRecords();
      await one.brands.ensure({ id: "laica", name: "laica" });
      // Written oldest first, so "newest first" is the reverse of the write
      // order and not the order the rows happen to arrive in.
      const older = await writeCall(one, caller.id, {
        brand: "laica",
        startedAt: at(1),
      });
      const newer = await writeCall(one, caller.id, {
        brand: "laica",
        kind: "crop",
        startedAt: at(2),
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const res = await app.request("/calls");

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(listed("/ui", html)).toEqual([newer, older]);
      expect(html).toContain("crop");
    },
    TIMEOUT
  );

  it(
    "leaves out a Call of a Brand the Caller does not hold",
    async () => {
      const { one, caller } = await openRecords();
      await one.brands.ensure({ id: "laica", name: "laica" });
      await one.brands.ensure({ id: "hopefamily", name: "Hope Family" });
      const mine = await writeCall(one, caller.id, { brand: "laica" });
      const theirs = await writeCall(one, caller.id, { brand: "hopefamily" });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const html = await (await app.request("/calls")).text();

      expect(listed("/ui", html)).toEqual([mine]);
      expect(html).not.toContain(theirs);
    },
    TIMEOUT
  );

  it(
    "answers 401 and asks the browser for Basic credentials without a Caller",
    async () => {
      const { one } = await openRecords();
      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(null),
      });

      const res = await app.request("/calls");

      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="meco"');
    },
    TIMEOUT
  );

  it(
    "refuses a Brand the Caller does not hold with 403 and the API's code",
    async () => {
      const { one, caller } = await openRecords();
      await one.brands.ensure({ id: "hopefamily", name: "Hope Family" });
      const theirs = await writeCall(one, caller.id, { brand: "hopefamily" });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const res = await app.request("/calls?brand=hopefamily");

      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("brand_not_held");
      expect(html).not.toContain(theirs);
    },
    TIMEOUT
  );

  it(
    "keeps only failed Calls under ?status=failed and names the module and code",
    async () => {
      const { one, caller } = await openRecords();
      await one.brands.ensure({ id: "laica", name: "laica" });
      const succeeded = await writeCall(one, caller.id, { brand: "laica" });
      const failed = await writeCall(one, caller.id, {
        brand: "laica",
        status: "failed",
        code: "no_subject",
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const html = await (await app.request("/calls?status=failed")).text();

      expect(listed("/ui", html)).toEqual([failed]);
      expect(html).not.toContain(succeeded);
      expect(html).toContain("frame");
      expect(html).toContain("no_subject");
    },
    TIMEOUT
  );

  it(
    "refuses a status that is no Call status with 400",
    async () => {
      const { one, caller } = await openRecords();

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const res = await app.request("/calls?status=broken");

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("bad_request");
    },
    TIMEOUT
  );

  it(
    "pages by cursor across every Brand the Caller holds without repeating or skipping a row",
    async () => {
      const { one, caller } = await openRecords();
      await one.brands.ensure({ id: "laica", name: "laica" });
      await one.brands.ensure({ id: "hopefamily", name: "Hope Family" });
      // Alternating Brands, so a page boundary falls inside both lists and a
      // merge that lost its place in either one shows up.
      const written: string[] = [];
      for (let n = 0; n < 5; n += 1) {
        written.push(
          await writeCall(one, caller.id, {
            brand: n % 2 === 0 ? "laica" : "hopefamily",
            startedAt: at(n),
          })
        );
      }

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica", "hopefamily")),
        // Mounted at the root, so the "older" link this page renders is a path
        // the sub-app itself answers and the walk below can follow verbatim.
        basePath: "",
        pageSize: 2,
      });

      const seen: string[] = [];
      let path = "/calls";
      for (let page = 0; page < 10; page += 1) {
        const html = await (await app.request(path)).text();
        seen.push(...listed("", html));
        const older = hrefs(html).find((href) => href.includes("cursor="));
        if (older === undefined) break;
        path = older;
      }

      expect(seen).toEqual([...written].reverse());
    },
    TIMEOUT
  );

  it(
    "refuses a cursor no page wrote with 400",
    async () => {
      const { one, caller } = await openRecords();

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const res = await app.request("/calls?cursor=not-a-cursor");

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("bad_request");
    },
    TIMEOUT
  );

  it(
    "escapes a Brand name that holds markup",
    async () => {
      const { one, caller } = await openRecords();
      await one.brands.ensure({
        id: "laica",
        name: "<script>alert(1)</script>",
      });
      await writeCall(one, caller.id, { brand: "laica" });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const html = await (await app.request("/calls")).text();

      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    },
    TIMEOUT
  );

  it(
    "renders an empty list rather than an error when the Caller has no Calls",
    async () => {
      const { one, caller } = await openRecords();

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const res = await app.request("/calls");

      expect(res.status).toBe(200);
      expect(listed("/ui", await res.text())).toEqual([]);
    },
    TIMEOUT
  );

  it(
    "answers 503 on every webui route when records does not answer",
    async () => {
      const { one, caller } = await openRecords();
      await one.close();

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      expect((await app.request("/calls")).status).toBe(503);
      expect((await app.request("/")).status).toBe(503);
    },
    TIMEOUT
  );
});

describe("the two lists link to each other", () => {
  it(
    "puts a link to the Calls list in the Gallery's header and one back in the list's",
    async () => {
      const { one, caller } = await openRecords();

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const gallery = await (await app.request("/")).text();
      expect(hrefs(gallery)).toContain("/ui/calls");

      const calls = await (await app.request("/calls")).text();
      expect(hrefs(calls)).toContain("/ui");
    },
    TIMEOUT
  );
});
