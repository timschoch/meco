import type { Annotation } from "@meco/contracts";
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

/** A Source Image records knows about, held by one Brand. 800 × 600. */
async function writeSource(
  one: Records,
  brand: string,
  word: string
): Promise<string> {
  const hash = hashOf(word);
  await one.files.ensure({
    hash,
    mime: "image/png",
    width: 800,
    height: 600,
    bytes: 4096,
    storeKey: `sources/${hash}.png`,
  });
  await one.sources.hold(brand, hash);
  return hash;
}

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

describe("the Source Thumbnail", () => {
  it(
    "puts the redirect route in the img src and no Signed URL anywhere in the page",
    async () => {
      const { one, caller } = await openRecords();
      const hash = await writeSource(one, "laica", "source");
      const call = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "crop",
        sourceHash: hash,
        status: "ok",
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const html = await (await app.request(`/calls/${call.id}`)).text();

      expect(sources(html)).toContain(`/ui/calls/${call.id}/source`);
      // The in-memory store's private host. A saved page must hold no URL that
      // hands over a photograph, so it may not appear anywhere on the page.
      expect(html).not.toContain("private.memory.store.invalid");
      expect(html).not.toContain("validUntil");
    },
    TIMEOUT
  );

  it(
    "answers 302 to a 60 second Signed URL when the Brand holds the Source Image",
    async () => {
      const { one, caller } = await openRecords();
      const hash = await writeSource(one, "laica", "source");
      const call = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "crop",
        sourceHash: hash,
        status: "ok",
      });

      const before = Date.now();
      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const res = await app.request(`/calls/${call.id}/source`);

      expect(res.status).toBe(302);
      const location = res.headers.get("Location") ?? "";
      expect(location).toContain(
        `private.memory.store.invalid/sources/${hash}.png`
      );
      // Sixty seconds and not the store's 300 second maximum: the URL outlives
      // the page load and nothing more.
      const validUntil = Number(
        new URL(location).searchParams.get("validUntil")
      );
      expect(validUntil).toBeGreaterThanOrEqual(before + 60_000);
      expect(validUntil).toBeLessThan(before + 61_000);
    },
    TIMEOUT
  );

  it(
    "answers 404 for a Source Image the Brand holds no Source Hold on",
    async () => {
      const { one, caller } = await openRecords();
      const hash = await writeSource(one, "laica", "source");
      // Another Brand's Call over the same bytes. That the File exists is not
      // that this Brand may see it.
      await one.sources.release("laica", hash);
      const call = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "crop",
        sourceHash: hash,
        status: "ok",
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const res = await app.request(`/calls/${call.id}/source`);

      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("private.memory.store.invalid");
    },
    TIMEOUT
  );

  it(
    "answers the same 404 for a Call of a Brand not held and for an unknown id",
    async () => {
      const { one, caller } = await openRecords();
      const hash = await writeSource(one, "hopefamily", "source");
      const theirs = await one.calls.record({
        callerId: caller.id,
        brand: "hopefamily",
        kind: "crop",
        sourceHash: hash,
        status: "ok",
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const notHeld = await app.request(`/calls/${theirs.id}/source`);
      const unknown = await app.request(`/calls/${crypto.randomUUID()}/source`);

      expect(notHeld.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(await notHeld.text()).toBe(await unknown.text());
    },
    TIMEOUT
  );

  it(
    "answers 401 without a Caller, and never asks records for the Call",
    async () => {
      const { one, caller } = await openRecords();
      const hash = await writeSource(one, "laica", "source");
      const call = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "crop",
        sourceHash: hash,
        status: "ok",
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(null),
      });

      const res = await app.request(`/calls/${call.id}/source`);

      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="meco"');
      expect(res.headers.get("Location")).toBe(null);
    },
    TIMEOUT
  );
});

/** One face Region, in source fractions, with the landmarks a face must carry. */
const face = (id: string, box: Annotation["regions"][number]["box"]) => ({
  id,
  kind: "face" as const,
  label: "face",
  box,
  score: 0.99,
  model: { name: "test", version: "1" },
  landmarks: {
    rEye: { x: box.x + 0.01, y: box.y + 0.01 },
    lEye: { x: box.x + 0.02, y: box.y + 0.01 },
    nose: { x: box.x + 0.015, y: box.y + 0.02 },
    rMouth: { x: box.x + 0.01, y: box.y + 0.03 },
    lMouth: { x: box.x + 0.02, y: box.y + 0.03 },
  },
});

const annotationOf = (
  hash: string,
  regions: Annotation["regions"]
): Annotation => ({
  schema: 1,
  hash,
  mime: "image/png",
  width: 800,
  height: 600,
  producedBy: [{ name: "test", version: "1" }],
  regions,
});

describe("the Overlay", () => {
  it(
    "places a Region at its box and the Crop Window divided by the File's own size",
    async () => {
      const { one, caller } = await openRecords();
      const hash = await writeSource(one, "laica", "source");
      await one.annotations.put(
        annotationOf(hash, [
          face("face-1", { x: 0.1, y: 0.2, width: 0.25, height: 0.3 }),
        ])
      );
      const call = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "crop",
        sourceHash: hash,
        status: "ok",
        // The File is 800 × 600, the Target is 1080 × 1080. Dividing by the
        // Target instead would put the window at 9.26% / 4.63% / 37% / 27.8%.
        framing: {
          window: { x: 100, y: 50, width: 400, height: 300 },
          windowFraction: { x: 0.125, y: 0.08333, width: 0.5, height: 0.5 },
          resolvedBy: "face",
          leadRegionId: "face-1",
          keptRegionIds: ["face-1"],
          droppedRegionIds: [],
          satisfied: true,
        },
        request: { target: { width: 1080, height: 1080 } },
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const html = await (await app.request(`/calls/${call.id}`)).text();

      expect(html).toContain("left: 10%; top: 20%; width: 25%; height: 30%");
      expect(html).toContain(
        "left: 12.5%; top: 8.3333%; width: 50%; height: 50%"
      );
      // Positioned elements and per cent, so the Overlay holds at any display
      // width. Nothing on the page runs.
      expect(html).not.toContain("<script");
    },
    TIMEOUT
  );

  it(
    "names the Person on a Match, says hidden on a redacted face, and falls back to the Region id",
    async () => {
      const { one, caller } = await openRecords();
      const hash = await writeSource(one, "laica", "source");
      await one.annotations.put(
        annotationOf(hash, [
          face("face-1", { x: 0.1, y: 0.1, width: 0.1, height: 0.1 }),
          face("face-2", { x: 0.5, y: 0.1, width: 0.1, height: 0.1 }),
          face("face-3", { x: 0.8, y: 0.1, width: 0.1, height: 0.1 }),
        ])
      );
      const person = await one.people.create({
        brand: "laica",
        name: "Nora Bianchi",
      });
      const call = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "crop",
        sourceHash: hash,
        status: "ok",
        matches: {
          matches: [
            {
              regionId: "face-1",
              personId: person.id,
              brand: "laica",
              similarity: 0.71,
            },
          ],
          faces: [
            {
              regionId: "face-1",
              verdict: "match",
              personId: person.id,
              similarity: 0.71,
            },
            { regionId: "face-2", verdict: "unknown", best: 0.2 },
            { regionId: "face-3", verdict: "uncompared", reason: "no-print" },
          ],
          unusableReferencePhotos: [],
        },
        redactions: [{ regionId: "face-2", reason: "unknown-face" }],
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const html = await (await app.request(`/calls/${call.id}`)).text();

      expect(html).toContain("Nora Bianchi");
      expect(html).toContain("hidden");
      expect(html).toContain("face-3");
      // The verdicts of the faces nobody matched are on the page too.
      expect(html).toContain("unknown");
      expect(html).toContain("uncompared");
    },
    TIMEOUT
  );

  it(
    "draws the Regions with no Crop Window for a Call that framed none",
    async () => {
      const { one, caller } = await openRecords();
      const hash = await writeSource(one, "laica", "source");
      await one.annotations.put(
        annotationOf(hash, [
          face("face-1", { x: 0.1, y: 0.2, width: 0.25, height: 0.3 }),
        ])
      );
      const call = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "annotate",
        sourceHash: hash,
        status: "ok",
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const res = await app.request(`/calls/${call.id}`);
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('class="region"');
      expect(html).not.toContain('class="window"');
      expect(html).toContain("This Call made no Output.");
    },
    TIMEOUT
  );
});

describe("a Replay", () => {
  it(
    "says the Call replayed an earlier Output and links the Call that made it",
    async () => {
      const { one, caller } = await openRecords();
      const request = { template: "story", fields: { title: "hello" } };
      const first = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "render",
        status: "ok",
        request,
      });
      await one.outputs.record({
        brand: "laica",
        storeKey: "renders/first.png",
        callId: first.id,
        kind: "render",
        requestHash: one.requestHash("laica", "render", request),
      });
      // The same request again: one Output, two Calls, the second with one Step.
      const replay = await one.calls.record({
        callerId: caller.id,
        brand: "laica",
        kind: "render",
        status: "ok",
        request,
        steps: [{ name: "records.replay", durMs: 4 }],
      });

      const app = webui({
        records: one,
        store: memoryStore(),
        caller: always(holding(caller, "laica")),
      });

      const html = await (await app.request(`/calls/${replay.id}`)).text();

      expect(html).toContain("replay");
      expect(hrefs(html)).toContain(`/ui/calls/${first.id}`);
      expect(html).toContain("renders/first.png");
    },
    TIMEOUT
  );
});
