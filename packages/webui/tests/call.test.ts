import { records, type Caller, type Records, type Step } from "@meco/records";
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

/**
 * A migrated database with the two Brands every check below writes Calls for:
 * `laica`, the one the Caller holds, and `hopefamily`, the one it does not.
 */
async function openRecords(): Promise<{ one: Records; caller: Caller }> {
  const one = records({ database: pgliteDatabase(), store: memoryStore() });
  opened.push(one);
  await one.migrate();
  await one.brands.ensure({ id: "laica", name: "laica" });
  await one.brands.ensure({ id: "hopefamily", name: "Hope Family" });
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

/** A Content Hash of the right shape, made from a word so a test can name it. */
const hashOf = (word: string): string =>
  word
    .padEnd(64, "0")
    .slice(0, 64)
    .replaceAll(/[^0-9a-f]/g, "a");

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

describe("the Call View", () => {
  it(
    "shows every Step in order with its duration, and the error of a failed Call",
    async () => {
      const { one, caller } = await openRecords();
      // `store.put` took no measurable time. A Step that ran is a Step that
      // happened, so it is on the page like the others.
      const steps: Step[] = [
        { name: "models.detect", durMs: 120 },
        { name: "frame.crop", durMs: 3 },
        { name: "store.put", durMs: 0 },
        { name: "compose.render", durMs: 40 },
      ];
      const call = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "render",
        status: "failed",
        steps,
        error: {
          module: "compose",
          code: "template_not_found",
          message: "no template named story",
        },
        durationMs: 163,
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const res = await app.request(`/calls/${call.id}`);
      expect(res.status).toBe(200);
      const html = await res.text();

      // In the order the gateway timed them, each with the duration it took.
      const named = steps.map((step) => html.indexOf(step.name));
      expect(named).toEqual([...named].sort((a, b) => a - b));
      expect(named[0]).toBeGreaterThan(-1);
      for (const step of steps) expect(html).toContain(`${step.durMs} ms`);

      expect(html).toContain("template_not_found");
      expect(html).toContain("no template named story");
      expect(html).toContain("compose");
    },
    TIMEOUT
  );

  it(
    "lists the Outputs this Call made, and no other Output of the Brand",
    async () => {
      const { one, caller } = await openRecords();
      const mine = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "render",
        status: "ok",
      });
      const other = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "render",
        status: "ok",
      });
      await one.outputs.record({
        brand: "laica",
        storeKey: "renders/mine.png",
        callId: mine.id,
        kind: "render",
        placement: "instagram-post",
        requestHash: hashOf("mine"),
      });
      await one.outputs.record({
        brand: "laica",
        storeKey: "renders/other.png",
        callId: other.id,
        kind: "render",
        requestHash: hashOf("other"),
      });

      const store = memoryStore();
      const app = webui({
        records: one,
        store,
        caller: always(holding(caller, "laica")),
      });

      const html = await (await app.request(`/calls/${mine.id}`)).text();

      expect(sources(html)).toContain(store.publicUrl("renders/mine.png"));
      expect(html).not.toContain("renders/other.png");
    },
    TIMEOUT
  );

  it(
    "shows the cost the gateway priced, and says so when it priced none",
    async () => {
      const { one, caller } = await openRecords();
      const priced = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "render",
        status: "ok",
        cost: { currency: "CHF", total: 0.014 },
      });
      const unpriced = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "render",
        status: "ok",
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const withCost = await (await app.request(`/calls/${priced.id}`)).text();
      expect(withCost).toContain("CHF");
      expect(withCost).toContain("0.014");

      const without = await (await app.request(`/calls/${unpriced.id}`)).text();
      expect(without).toContain("not priced");
    },
    TIMEOUT
  );

  it(
    "answers the same bytes for a Call of a Brand the Caller does not hold and for an unknown id",
    async () => {
      const { one, caller } = await openRecords();
      const theirs = await one.calls.record({
        callerId: caller.id,
        brand: "hopefamily",
        kind: "render",
        status: "ok",
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const notHeld = await app.request(`/calls/${theirs.id}`);
      const unknown = await app.request(`/calls/${crypto.randomUUID()}`);

      expect(notHeld.status).toBe(404);
      expect(unknown.status).toBe(404);
      // Byte-identical, so the page does not say the id exists.
      expect(await notHeld.text()).toBe(await unknown.text());
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

      const res = await app.request(`/calls/${crypto.randomUUID()}`);

      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="meco"');
    },
    TIMEOUT
  );

  it(
    "answers 503 when records does not answer",
    async () => {
      const { one, caller } = await openRecords();
      const call = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "render",
        status: "ok",
      });
      await one.close();

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      expect((await app.request(`/calls/${call.id}`)).status).toBe(503);
    },
    TIMEOUT
  );

  it(
    "links the Gallery back from the Call View",
    async () => {
      const { one, caller } = await openRecords();
      const call = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "render",
        status: "ok",
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const html = await (await app.request(`/calls/${call.id}`)).text();
      expect(hrefs(html)).toContain("/ui");
    },
    TIMEOUT
  );
});
