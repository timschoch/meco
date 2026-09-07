// The tracer bullet: a story from one photograph, through every module in the
// spec's order, on real compose, frame, redact and identify, with records on
// PGlite, the in-memory store and the models wire faked from committed
// fixtures.
import { templates } from "@meco/compose";
import { describe, expect, it } from "vitest";
import type { Call } from "@meco/records";
import { fixtureAnnotation, fixtureBytes, sha256 } from "./annotations";
import { KEY, PHOTOS, TIMEOUT, rpc, useStacks, type Opened } from "./harness";

const stack = useStacks();

const FILE = "artemis-2-crew.jpg";
const BYTES = fixtureBytes(FILE);
const HASH = sha256(BYTES);
/** Held by the test Caller, and the Brand whose story Template this is. */
const BRAND = "hopefamily";
const TEMPLATE = "hopefamily-story";
const PLACEMENT = "instagram/story";

/** The Template's own example Fields, so what is rendered is what it documents. */
const FIELDS = templates(BRAND).find((one) => one.id === TEMPLATE)?.example as
  Record<string, unknown> | undefined;

type Answer = {
  status: number;
  body: {
    output?: {
      url: string;
      key: string;
      kind: string;
      placement: string;
      width: number;
      height: number;
      mime: string;
      bytes: number;
    };
    call?: { id: string; replayed: boolean };
    framing?: {
      resolvedBy: string;
      leadRegionId?: string;
      windowFraction: unknown;
    };
    faces?: {
      regionId: string;
      verdict: string;
      hidden: boolean;
      inFrame: boolean;
    }[];
    error?: { code: string; message: string };
  };
};

async function render(
  one: Opened,
  body: Record<string, unknown>,
  app = one.app()
): Promise<Answer> {
  const res = await app.request("/v1/render", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      brand: BRAND,
      template: TEMPLATE,
      placement: PLACEMENT,
      fields: FIELDS,
      ...body,
    }),
  });
  return { status: res.status, body: (await res.json()) as Answer["body"] };
}

/** The story, from the fixture photograph's URL. */
const story = (
  one: Opened,
  extra: Record<string, unknown> = {},
  app?: ReturnType<Opened["app"]>
): Promise<Answer> =>
  render(one, { source: { url: `${PHOTOS}/${FILE}` }, ...extra }, app);

const call = async (one: Opened, id: string | undefined): Promise<Call> => {
  const found = id === undefined ? null : await one.records.calls.get(id);
  if (found === null) throw new Error(`no Call ${String(id)}`);
  return found;
};

const stepNames = (recorded: Call) => recorded.steps.map((s) => s.name);

/** The face Regions of the fixture, which is every Region it carries. */
const FACE_IDS = fixtureAnnotation(FILE).regions.map((one) => one.id);

describe("POST /v1/render on a photograph meco has never seen", () => {
  it(
    "answers a story under renders/, the Framing that placed it and one Face Report per face",
    async () => {
      const one = await stack();
      const { status, body } = await story(one);

      expect(status).toBe(200);
      // The Namespace, because a Render in the wrong one is a private object
      // served from a public URL or the other way round.
      expect(body.output?.key.startsWith("renders/")).toBe(true);
      expect(body.output?.url).toContain(body.output?.key);
      expect(body.output).toMatchObject({
        kind: "render",
        placement: PLACEMENT,
        width: 1080,
        height: 1920,
        mime: "image/jpeg",
      });
      expect(body.output?.bytes).toBeGreaterThan(0);

      // No Person is enrolled and the photograph has no vehicle, so the `match`
      // and `kart` rungs yield nothing and a face composes the Subject.
      expect(body.framing?.resolvedBy).toBe("face");
      expect(body.framing?.leadRegionId).toBeDefined();

      expect(body.faces?.map((f) => f.regionId)).toEqual(FACE_IDS);
      expect(body.call?.replayed).toBe(false);
    },
    TIMEOUT
  );

  it(
    "runs the modules in the spec's order and records one Step for each",
    async () => {
      const one = await stack();
      const { body } = await story(one);
      const recorded = await call(one, body.call?.id);

      expect(recorded).toMatchObject({
        brand: BRAND,
        kind: "render",
        status: "ok",
        sourceHash: HASH,
        error: null,
      });
      // The Source Reference is the hash on the row, never the URL it arrived
      // as, so two URLs of one photograph record the same request.
      expect(recorded.request).toMatchObject({ source: { hash: HASH } });
      expect(stepNames(recorded)).toEqual([
        "source.fetch",
        "records.replay",
        "records.annotations.get",
        // The photograph is filed before models sees it, because models is
        // handed a Signed URL and cannot fetch what is not in the store yet.
        "source.facts",
        "store.put",
        "records.files.ensure",
        "store.signedUrl",
        "models.annotate",
        "models.fetch",
        "models.decode",
        "models.yunet",
        "models.dfine",
        "models.edgeface",
        "records.annotations.put",
        "records.sources.hold",
        "identify.match",
        "records.brand",
        "compose.plan",
        "frame.crop",
        "source.decode",
        "redact.blur",
        "compose.render",
        "store.put",
      ]);
      // The three shapes the webui draws a Call from, kept unread.
      expect(recorded.framing).toMatchObject({ resolvedBy: "face" });
      expect(recorded.matches).toMatchObject({ matches: [] });
      expect(recorded.redactions).toHaveLength(FACE_IDS.length);
    },
    TIMEOUT
  );

  it(
    "answers the same JSON as the render_image tool, with structuredContent",
    async () => {
      const one = await stack();
      const app = one.app();
      const http = await story(one, {}, app);
      const tool = await rpc(app, {
        method: "tools/call",
        params: {
          name: "render_image",
          arguments: {
            brand: BRAND,
            template: TEMPLATE,
            placement: PLACEMENT,
            fields: FIELDS,
            source: { hash: HASH },
          },
        },
      });
      const result = tool.result as {
        content: { text: string }[];
        structuredContent: { output: { key: string }; framing: unknown };
      };

      expect(result.structuredContent.output.key).toBe(http.body.output?.key);
      expect(result.structuredContent.framing).toEqual(http.body.framing);
      expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({
        output: { key: http.body.output?.key },
      });
    },
    TIMEOUT
  );
});

describe("the Replay", () => {
  it(
    "answers the same URL from records, with no module call but records.*",
    async () => {
      const one = await stack();
      const app = one.app();
      const first = await story(one, {}, app);
      const again = await story(one, {}, app);
      const recorded = await call(one, again.body.call?.id);

      expect(again.body.output?.key).toBe(first.body.output?.key);
      expect(again.body.call?.replayed).toBe(true);
      expect(again.body.call?.id).not.toBe(first.body.call?.id);
      // Everything the Framing and the Face Report say comes back off the Call
      // the Output was made by.
      expect(again.body.framing).toEqual(first.body.framing);
      expect(again.body.faces).toEqual(first.body.faces);

      expect(stepNames(recorded)).toEqual(["source.fetch", "records.replay"]);
      expect(one.modelsSeen.filter((s) => s === "POST /annotate")).toHaveLength(
        1
      );
    },
    TIMEOUT
  );

  it(
    "makes one Output and two Calls, whichever of a photograph's URLs named it",
    async () => {
      const one = await stack();
      const app = one.app();
      // Two addresses, one photograph: the fake host ignores the query.
      const first = await render(
        one,
        { source: { url: `${PHOTOS}/${FILE}?from=cms` } },
        app
      );
      const second = await render(
        one,
        { source: { url: `${PHOTOS}/${FILE}?from=drive` } },
        app
      );

      expect(second.body.output?.key).toBe(first.body.output?.key);
      expect(second.body.call?.replayed).toBe(true);

      const outputs = await one.records.outputs.list({
        brand: BRAND,
        limit: 10,
      });
      const calls = await one.records.calls.list({ brand: BRAND, limit: 10 });
      expect(outputs.rows).toHaveLength(1);
      expect(calls.rows).toHaveLength(2);
    },
    TIMEOUT
  );

  it(
    "answers a `{ hash }` request off records alone, fetching nothing",
    async () => {
      const one = await stack();
      const app = one.app();
      await story(one, {}, app);
      const byHash = await render(one, { source: { hash: HASH } }, app);
      const recorded = await call(one, byHash.body.call?.id);

      // The `{ hash }` body hashes to the same request as the `{ url }` one,
      // because the Request Hash covers the Source Reference as `{ hash }`.
      expect(byHash.body.call?.replayed).toBe(true);
      expect(one.photosSeen).toHaveLength(1);
      expect(stepNames(recorded)).toEqual([
        "records.sources.heldBy",
        "records.replay",
      ]);
      expect(stepNames(recorded).every((s) => s.startsWith("records."))).toBe(
        true
      );
    },
    TIMEOUT
  );
});

describe("redaction", () => {
  it(
    "hides every face meco cannot name, because blurUnknownFaces defaulted to true",
    async () => {
      const one = await stack();
      const { body } = await story(one);

      // The Brand enrolled nobody, so no face is named and every one is hidden.
      expect(body.faces?.map((f) => f.hidden)).toEqual(
        FACE_IDS.map(() => true)
      );
    },
    TIMEOUT
  );

  it(
    "hides nothing when the caller asks for nothing hidden, and renders again",
    async () => {
      const one = await stack();
      const app = one.app();
      const blurred = await story(one, {}, app);
      const plain = await story(
        one,
        { redaction: { blurUnknownFaces: false } },
        app
      );

      expect(plain.body.faces?.map((f) => f.hidden)).toEqual(
        FACE_IDS.map(() => false)
      );
      // A different policy is a different request, so it is a second Output and
      // not a Replay of the blurred one.
      expect(plain.body.call?.replayed).toBe(false);
      expect(plain.body.output?.key).not.toBe(blurred.body.output?.key);
    },
    TIMEOUT
  );
});

describe("a request the FramingRequest schema refuses", () => {
  it(
    "is 400 invalid_request from the contract, before frame runs, and a failed Call",
    async () => {
      const one = await stack();
      // The door's own schema allows a ladder naming a rung twice; the
      // contracts schema is what refuses it, which is the point.
      const { status, body } = await story(one, { pinTo: ["face", "face"] });
      const calls = await one.records.calls.list({ brand: BRAND, limit: 10 });
      const failed = calls.rows[0];

      expect(status).toBe(400);
      expect(body.error?.code).toBe("invalid_request");
      expect(failed?.status).toBe("failed");
      expect(failed?.error?.module).toBe("gateway");
      expect(stepNames(failed as Call)).not.toContain("frame.crop");
    },
    TIMEOUT
  );
});

describe("a module's refusal", () => {
  it.each([
    ["unknown_template", 404, { template: "no-such-template" }],
    ["placement_not_supported", 400, { placement: "linkedin/wide" }],
    ["invalid_fields", 400, { fields: { title: 1 } }],
  ])(
    "keeps compose's %s code and its status, and the Call is a row",
    async (code, status, override) => {
      const one = await stack();
      const answer = await story(one, override);
      const calls = await one.records.calls.list({ brand: BRAND, limit: 10 });

      expect(answer.status).toBe(status);
      expect(answer.body.error?.code).toBe(code);
      expect(calls.rows[0]).toMatchObject({
        status: "failed",
        error: { module: "compose", code },
      });
    },
    TIMEOUT
  );
});

describe("the gateway's own invariant", () => {
  it(
    "refuses a photograph that decodes to a size the Annotation does not describe",
    async () => {
      const one = await stack();
      // A complete Annotation for these bytes that claims another size: the
      // cache answers it, so nothing re-annotates and only the decode can
      // notice. Every Region fraction would otherwise mean two things.
      const complete = fixtureAnnotation(FILE);
      await one.records.files.ensure({
        hash: HASH,
        mime: "image/jpeg",
        width: complete.width,
        height: complete.height,
        bytes: BYTES.byteLength,
        storeKey: (await one.store.put("sources", BYTES, "image/jpeg")).key,
      });
      await one.records.annotations.put({
        ...complete,
        width: 640,
        height: 800,
      });
      await one.records.sources.hold(BRAND, HASH);

      const { status, body } = await render(one, { source: { hash: HASH } });
      const calls = await one.records.calls.list({ brand: BRAND, limit: 10 });

      expect(status).toBe(500);
      expect(body.error?.code).toBe("resolution_mismatch");
      expect(calls.rows[0]).toMatchObject({
        status: "failed",
        error: { module: "gateway", code: "resolution_mismatch" },
      });
    },
    TIMEOUT
  );
});
