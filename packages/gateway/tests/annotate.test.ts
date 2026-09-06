import { describe, expect, it } from "vitest";
import { type Call } from "@meco/records";
import { fixtureAnnotation, fixtureBytes, sha256 } from "./annotations";
import {
  HELD,
  KEY,
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
