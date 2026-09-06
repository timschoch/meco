import { records, type Caller, type Records } from "@meco/records";
import { pgliteDatabase } from "@meco/records/pglite";
import { memoryStore } from "@meco/store";
import { afterEach, describe, expect, it } from "vitest";
import { webui } from "../index";

/**
 * The whole suite runs on PGlite and the in-memory store, so no check here
 * reaches Neon or Blob. Booting PGlite costs more than Vitest's default five
 * seconds under the load of a full `pnpm check`, hence the timeouts.
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
 * One Output of a Brand, with the Call it came from. Written through records'
 * own methods, so the Gallery is asserted against real rows and the real
 * cursor rather than a stub.
 */
async function writeOutput(
  one: Records,
  callerId: string,
  what: {
    brand: string;
    storeKey: string;
    kind?: "crop" | "render" | "carousel";
    placement?: string | null;
  }
): Promise<string> {
  const call = await one.calls.record({
    callerId,
    brand: what.brand,
    kind: what.kind ?? "render",
    status: "ok",
  });
  await one.outputs.record({
    brand: what.brand,
    storeKey: what.storeKey,
    callId: call.id,
    kind: what.kind ?? "render",
    placement: what.placement ?? null,
    requestHash: what.storeKey,
  });
  return call.id;
}

/** Every `href` the page holds, in the order they appear. */
const hrefs = (html: string): string[] =>
  [...html.matchAll(/href="([^"]*)"/g)].map((match) =>
    (match[1] ?? "").replaceAll("&amp;", "&")
  );

/** Every `<img src>` the page holds, in the order they appear. */
const sources = (html: string): string[] =>
  [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map(
    (match) => match[1] ?? ""
  );

describe("webui without a Caller", () => {
  it(
    "answers 401 and asks the browser for Basic credentials",
    async () => {
      const { one } = await openRecords();
      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(null),
      });

      const res = await app.request("/");

      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="meco"');
      expect(await res.text()).not.toContain("<img");
    },
    TIMEOUT
  );
});

describe("the Gallery", () => {
  it(
    "lists the Caller's Outputs newest first, each card an image at its Public URL linking its Call View",
    async () => {
      const { one, caller } = await openRecords();
      await one.brands.ensure({ id: "laica", name: "laica" });
      // Written oldest first, so "newest first" is the reverse of the write
      // order and not the order the rows happen to arrive in.
      const older = await writeOutput(one, caller.id, {
        brand: "laica",
        storeKey: "renders/aaa.png",
      });
      const newer = await writeOutput(one, caller.id, {
        brand: "laica",
        storeKey: "renders/bbb.png",
      });

      const store = memoryStore();
      const app = webui({
        records: one,
        store,
        caller: always(holding(caller, "laica")),
      });

      const html = await (await app.request("/")).text();

      expect(sources(html)).toEqual([
        store.publicUrl("renders/bbb.png"),
        store.publicUrl("renders/aaa.png"),
      ]);
      expect(html).toContain('loading="lazy"');
      expect(html).toContain('decoding="async"');
      const cards = hrefs(html).filter((href) => href.includes("/calls/"));
      expect(cards).toEqual([`/ui/calls/${newer}`, `/ui/calls/${older}`]);
    },
    TIMEOUT
  );

  it(
    "leaves out an Output of a Brand the Caller does not hold",
    async () => {
      const { one, caller } = await openRecords();
      await one.brands.ensure({ id: "laica", name: "laica" });
      await one.brands.ensure({ id: "hopefamily", name: "Hope Family" });
      await writeOutput(one, caller.id, {
        brand: "laica",
        storeKey: "renders/mine.png",
      });
      await writeOutput(one, caller.id, {
        brand: "hopefamily",
        storeKey: "renders/theirs.png",
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const html = await (await app.request("/")).text();

      expect(html).toContain("renders/mine.png");
      expect(html).not.toContain("renders/theirs.png");
    },
    TIMEOUT
  );

  it(
    "refuses a Brand the Caller does not hold with 403 and the API's code",
    async () => {
      const { one, caller } = await openRecords();
      await one.brands.ensure({ id: "hopefamily", name: "Hope Family" });
      await writeOutput(one, caller.id, {
        brand: "hopefamily",
        storeKey: "renders/theirs.png",
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const res = await app.request("/?brand=hopefamily");

      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("brand_not_held");
      expect(html).not.toContain("renders/theirs.png");
    },
    TIMEOUT
  );

  it(
    "narrows by Placement and by kind",
    async () => {
      const { one, caller } = await openRecords();
      await one.brands.ensure({ id: "laica", name: "laica" });
      await writeOutput(one, caller.id, {
        brand: "laica",
        storeKey: "renders/story.png",
        kind: "render",
        placement: "instagram-story",
      });
      await writeOutput(one, caller.id, {
        brand: "laica",
        storeKey: "renders/post.png",
        kind: "render",
        placement: "instagram-post",
      });
      await writeOutput(one, caller.id, {
        brand: "laica",
        storeKey: "crops/bare.png",
        kind: "crop",
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const byPlacement = await (
        await app.request("/?placement=instagram-story")
      ).text();
      expect(sources(byPlacement)).toHaveLength(1);
      expect(byPlacement).toContain("renders/story.png");

      const byKind = await (await app.request("/?kind=crop")).text();
      expect(sources(byKind)).toHaveLength(1);
      expect(byKind).toContain("crops/bare.png");
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
        const key = `renders/o${n}.png`;
        await writeOutput(one, caller.id, {
          brand: n % 2 === 0 ? "laica" : "hopefamily",
          storeKey: key,
        });
        written.push(key);
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
      let path = "/";
      for (let page = 0; page < 10; page += 1) {
        const html = await (await app.request(path)).text();
        for (const src of sources(html)) {
          seen.push(src.slice(src.indexOf("renders/")));
        }
        const older = hrefs(html).find((href) => href.includes("cursor="));
        if (older === undefined) break;
        path = older;
      }

      expect(seen).toEqual([...written].reverse());
    },
    TIMEOUT
  );

  it(
    "ships the stylesheet as CSS and not as escaped markup",
    async () => {
      const { one, caller } = await openRecords();

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const html = await (await app.request("/")).text();
      const style = html.slice(
        html.indexOf("<style"),
        html.indexOf("</style>")
      );

      // A browser does not decode an entity inside `<style>`, so an escaped
      // quote is a rule that silently does not apply.
      expect(style).toContain('"Segoe UI"');
      expect(style).not.toContain("&quot;");
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
      await writeOutput(one, caller.id, {
        brand: "laica",
        storeKey: "renders/one.png",
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const html = await (await app.request("/")).text();

      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    },
    TIMEOUT
  );

  it(
    "renders an empty Gallery rather than an error when the Caller has no Outputs",
    async () => {
      const { one, caller } = await openRecords();

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const res = await app.request("/");

      expect(res.status).toBe(200);
      expect(sources(await res.text())).toEqual([]);
    },
    TIMEOUT
  );

  it(
    "answers 503 when records does not answer",
    async () => {
      const { one, caller } = await openRecords();
      await one.close();

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const res = await app.request("/");

      expect(res.status).toBe(503);
    },
    TIMEOUT
  );
});
