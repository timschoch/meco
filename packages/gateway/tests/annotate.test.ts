import { describe, expect, it } from "vitest";
import { type Call } from "@meco/records";
import { fixtureAnnotation, fixtureBytes, sha256 } from "./annotations";
import {
  HELD,
  KEY,
  NOT_HELD,
  PHOTOS,
  TIMEOUT,
  rpc,
  useStacks,
  type Opened,
} from "./harness";

const stack = useStacks();

const FILE = "artemis-2-crew.jpg";
const BYTES = fixtureBytes(FILE);
const HASH = sha256(BYTES);
const BRAND = HELD[0];

type Answer = {
  status: number;
  body: {
    call?: { id: string };
    annotation?: { hash: string; regions: unknown[] };
    error?: { code: string; message: string };
  };
};

async function annotate(
  one: Opened,
  source: unknown,
  app = one.app()
): Promise<Answer> {
  const res = await app.request("/v1/annotate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ brand: BRAND, source }),
  });
  return { status: res.status, body: (await res.json()) as Answer["body"] };
}

/** Every key named `facePrint` anywhere in a JSON value. */
function keysNamed(value: unknown, name: string, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((one, i) => keysNamed(one, name, found));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, one] of Object.entries(value)) {
      if (key === name) found.push(key);
      keysNamed(one, name, found);
    }
  }
  return found;
}

const call = async (one: Opened, id: string | undefined): Promise<Call> => {
  const found = id === undefined ? null : await one.records.calls.get(id);
  if (found === null) throw new Error(`no Call ${String(id)}`);
  return found;
};

const stepNames = (recorded: Call) => recorded.steps.map((s) => s.name);

describe("the Annotation cache", () => {
  it(
    "answers the same photograph again from records, with no models Step and no second fetch of the store",
    async () => {
      const one = await stack();
      const app = one.app();
      await annotate(one, { url: `${PHOTOS}/${FILE}` }, app);
      const again = await annotate(one, { url: `${PHOTOS}/${FILE}` }, app);
      const recorded = await call(one, again.body.call?.id);

      expect(again.status).toBe(200);
      expect(again.body.annotation?.hash).toBe(HASH);
      expect(one.modelsSeen.filter((s) => s === "POST /annotate")).toHaveLength(1);
      expect(stepNames(recorded)).toEqual([
        "source.fetch",
        "records.annotations.get",
        "records.sources.hold",
      ]);
    },
    TIMEOUT
  );

  it(
    "re-annotates a row an older Catalogue wrote and replaces it",
    async () => {
      const one = await stack();
      const complete = fixtureAnnotation(FILE);
      const stale = {
        ...complete,
        producedBy: complete.producedBy.filter((m) => m.name !== "dfine"),
      };
      await one.records.files.ensure({
        hash: HASH,
        mime: "image/jpeg",
        width: 1280,
        height: 1600,
        bytes: BYTES.byteLength,
        storeKey: `sources/${HASH}.jpg`,
      });
      await one.records.annotations.put(stale);

      const { status, body } = await annotate(one, {
        url: `${PHOTOS}/${FILE}`,
      });
      const recorded = await call(one, body.call?.id);

      expect(status).toBe(200);
      expect(one.modelsSeen).toContain("POST /annotate");
      expect(stepNames(recorded)).toContain("models.annotate");
      await expect(one.records.annotations.get(HASH)).resolves.toEqual(complete);
    },
    TIMEOUT
  );
});

describe("a { hash } Source Reference", () => {
  it(
    "is 404 not_found for a hash this Brand holds no Source Hold on, whether or not the bytes exist",
    async () => {
      const one = await stack();
      // Filed by another Brand: the bytes exist, this Brand may not name them.
      const other = one.app().request("/v1/annotate", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          brand: HELD[1],
          source: { url: `${PHOTOS}/${FILE}` },
        }),
      });
      expect((await other).status).toBe(200);

      const known = await annotate(one, { hash: HASH });
      const unknown = await annotate(one, { hash: "0".repeat(64) });

      expect(known.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(known.body.error?.code).toBe("not_found");
      // The same answer word for word, bar the hash the caller itself sent.
      expect(known.body.error?.message.replace(HASH, "<hash>")).toBe(
        unknown.body.error?.message.replace("0".repeat(64), "<hash>")
      );
    },
    TIMEOUT
  );

  it(
    "answers from the cache once the Brand holds it, fetching nothing",
    async () => {
      const one = await stack();
      const app = one.app();
      await annotate(one, { url: `${PHOTOS}/${FILE}` }, app);
      const byHash = await annotate(one, { hash: HASH }, app);
      const recorded = await call(one, byHash.body.call?.id);

      expect(byHash.status).toBe(200);
      expect(byHash.body.annotation?.hash).toBe(HASH);
      expect(one.photosSeen).toHaveLength(1);
      expect(stepNames(recorded)).toEqual([
        "records.annotations.get",
        "records.sources.hold",
      ]);
    },
    TIMEOUT
  );

  it(
    "reads the bytes off the store when the held row is incomplete",
    async () => {
      const one = await stack();
      const complete = fixtureAnnotation(FILE);
      await one.records.files.ensure({
        hash: HASH,
        mime: "image/jpeg",
        width: 1280,
        height: 1600,
        bytes: BYTES.byteLength,
        storeKey: (await one.store.put("sources", BYTES, "image/jpeg")).key,
      });
      await one.records.annotations.put({ ...complete, producedBy: [] });
      await one.records.sources.hold(BRAND, HASH);

      const { status, body } = await annotate(one, { hash: HASH });
      const recorded = await call(one, body.call?.id);

      expect(status).toBe(200);
      expect(one.photosSeen).toEqual([]);
      expect(stepNames(recorded).slice(0, 3)).toEqual([
        "records.annotations.get",
        "store.get",
        "models.annotate",
      ]);
      await expect(one.records.annotations.get(HASH)).resolves.toEqual(complete);
    },
    TIMEOUT
  );
});

describe("the Brand Wall on annotate", () => {
  it(
    "refuses a Brand the Caller does not hold before anything is fetched",
    async () => {
      const one = await stack();
      const res = await one.app().request("/v1/annotate", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          brand: NOT_HELD,
          source: { url: `${PHOTOS}/${FILE}` },
        }),
      });
      expect(res.status).toBe(403);
      expect(one.photosSeen).toEqual([]);
      expect(one.modelsSeen).toEqual([]);
    },
    TIMEOUT
  );
});

describe("POST /v1/annotate on a photograph meco has never seen", () => {
  it(
    "fetches the URL, files the bytes, runs the whole Catalogue once and answers the Annotation without its prints",
    async () => {
      const one = await stack();
      const { status, body } = await annotate(one, {
        url: `${PHOTOS}/${FILE}`,
      });

      expect(status).toBe(200);
      expect(body.annotation?.hash).toBe(HASH);
      expect(body.annotation?.regions).toHaveLength(4);
      // The fixture Annotation carries four prints; the wire carries none.
      expect(keysNamed(fixtureAnnotation(FILE), "facePrint")).toHaveLength(4);
      expect(keysNamed(body, "facePrint")).toEqual([]);

      // Filed: the bytes under `sources/`, the File, the Annotation with its
      // prints, and this Brand's Source Hold.
      expect(one.photosSeen).toEqual([`${PHOTOS}/${FILE}`]);
      expect(one.modelsSeen.filter((s) => s === "POST /annotate")).toHaveLength(1);
      await expect(one.store.get(`sources/${HASH}.jpg`)).resolves.toEqual(BYTES);
      await expect(one.records.files.get(HASH)).resolves.toMatchObject({
        hash: HASH,
        mime: "image/jpeg",
        width: 1280,
        height: 1600,
        bytes: BYTES.byteLength,
        storeKey: `sources/${HASH}.jpg`,
      });
      await expect(one.records.annotations.get(HASH)).resolves.toEqual(
        fixtureAnnotation(FILE)
      );
      await expect(one.records.sources.heldBy(BRAND, HASH)).resolves.toBe(true);
    },
    TIMEOUT
  );

  it(
    "records the Call with the Source Reference replaced by its hash and one Step per stage, models' own clock included",
    async () => {
      const one = await stack();
      const { body } = await annotate(one, { url: `${PHOTOS}/${FILE}` });
      const recorded = await call(one, body.call?.id);

      expect(recorded).toMatchObject({
        brand: BRAND,
        kind: "annotate",
        status: "ok",
        sourceHash: HASH,
        request: { brand: BRAND, source: { hash: HASH } },
        error: null,
        matches: null,
      });
      expect(recorded.durationMs).toBeGreaterThanOrEqual(0);
      expect(recorded.steps.map((s) => s.name)).toEqual([
        "source.fetch",
        "records.annotations.get",
        "models.annotate",
        "models.decode",
        "models.yunet",
        "models.dfine",
        "models.edgeface",
        "store.put",
        "records.files.ensure",
        "records.annotations.put",
        "records.sources.hold",
      ]);
      // models' stages carry the host's numbers, not the gateway's wall clock.
      expect(recorded.steps.find((s) => s.name === "models.yunet")?.durMs).toBe(
        43.6
      );
    },
    TIMEOUT
  );

  it(
    "answers the same JSON as the find_subjects tool, with structuredContent",
    async () => {
      const one = await stack();
      const app = one.app();
      const http = await annotate(one, { url: `${PHOTOS}/${FILE}` }, app);
      const tool = await rpc(app, {
        method: "tools/call",
        params: {
          name: "find_subjects",
          arguments: { brand: BRAND, source: { hash: HASH } },
        },
      });
      const result = tool.result as {
        content: { text: string }[];
        structuredContent: { annotation: unknown; call: unknown };
      };
      expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({
        annotation: http.body.annotation,
      });
      expect(result.structuredContent.annotation).toEqual(http.body.annotation);
    },
    TIMEOUT
  );
});
