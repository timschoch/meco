// The bare Crop: the same tracer bullet as `render`, with compose's `cut` in
// place of the Plan and the Template. Real compose, frame, redact and identify,
// records on PGlite, the in-memory store, and the models wire faked from
// committed fixtures.
import type { Call } from "@meco/records";
import { describe, expect, it } from "vitest";
import {
  KART_FILE,
  KART_GRID_FILE,
  fixtureAnnotation,
  fixtureBytes,
  sha256,
} from "./annotations";
import { KEY, PHOTOS, TIMEOUT, rpc, useStacks, type Opened } from "./harness";

const stack = useStacks();

/** Two karts, two drivers, both visors down: YuNet finds no face here, so only
 * the `kart` rung can place the window. The photograph the feature exists for. */
const KART = KART_FILE;
const KART_HASH = sha256(fixtureBytes(KART));

/** Twelve faces and no vehicle, so the Face Report has something to say. */
const CREW = "artemis-2-crew.jpg";
const CREW_FACE_IDS = fixtureAnnotation(CREW).regions.map((one) => one.id);

/** Held by the test Caller. A Crop needs no Template, so any held Brand does. */
const BRAND = "laica";

const WIDTH = 1080;
const HEIGHT = 1350;

type Answer = {
  status: number;
  body: {
    output?: {
      url: string;
      key: string;
      kind: string;
      placement?: unknown;
      width: number;
      height: number;
      mime: string;
      bytes: number;
    };
    call?: { id: string; replayed: boolean };
    framing?: {
      resolvedBy: string;
      leadRegionId?: string;
      windowFraction: { x: number; y: number; width: number; height: number };
    };
    faces?: {
      regionId: string;
      verdict: string;
      hidden: boolean;
      inFrame: boolean;
    }[];
    numbers?: {
      regionId: string;
      label: string;
      personId?: string;
      inFrame?: boolean;
    }[];
    error?: { code: string; message: string };
  };
};

async function post(
  one: Opened,
  body: Record<string, unknown>,
  app = one.app()
): Promise<Answer> {
  const res = await app.request("/v1/crop", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      brand: BRAND,
      width: WIDTH,
      height: HEIGHT,
      ...body,
    }),
  });
  return { status: res.status, body: (await res.json()) as Answer["body"] };
}

/** The Crop of one fixture photograph, by its URL on the fake host. */
const crop = (
  one: Opened,
  file: string,
  extra: Record<string, unknown> = {},
  app?: ReturnType<Opened["app"]>
): Promise<Answer> =>
  post(one, { source: { url: `${PHOTOS}/${file}` }, ...extra }, app);

const call = async (one: Opened, id: string | undefined): Promise<Call> => {
  const found = id === undefined ? null : await one.records.calls.get(id);
  if (found === null) throw new Error(`no Call ${String(id)}`);
  return found;
};

const stepNames = (recorded: Call) => recorded.steps.map((s) => s.name);

describe("POST /v1/crop on a photograph meco has never seen", () => {
  it(
    "answers a Crop under crops/, at the size asked for, framed on the kart",
    async () => {
      const one = await stack();
      const { status, body } = await crop(one, KART);

      expect(status).toBe(200);
      // The Namespace, because a Crop in the wrong one is a private object
      // served from a public URL or the other way round.
      expect(body.output?.key.startsWith("crops/")).toBe(true);
      expect(body.output?.url).toContain(body.output?.key);
      expect(body.output).toMatchObject({
        kind: "crop",
        width: WIDTH,
        height: HEIGHT,
        mime: "image/jpeg",
      });
      expect(body.output?.bytes).toBeGreaterThan(0);
      // A Crop is a size, not a Channel: there is no Placement to name.
      expect(body.output?.placement).toBeUndefined();

      // No Person is enrolled and YuNet finds no face through these visors, so
      // the `match` and `face` rungs yield nothing and the kart is the Subject.
      expect(body.framing?.resolvedBy).toBe("kart");
      expect(body.framing?.leadRegionId).toBeDefined();
      expect(body.faces).toEqual([]);
      expect(body.call?.replayed).toBe(false);
    },
    TIMEOUT
  );

  it(
    "runs the modules in the spec's order, with compose.cut and no Plan",
    async () => {
      const one = await stack();
      const { body } = await crop(one, KART);
      const recorded = await call(one, body.call?.id);

      expect(recorded).toMatchObject({
        brand: BRAND,
        kind: "crop",
        status: "ok",
        sourceHash: KART_HASH,
        error: null,
      });
      // The Source Reference is the hash on the row, never the URL it arrived
      // as, so two URLs of one photograph record the same request.
      expect(recorded.request).toMatchObject({ source: { hash: KART_HASH } });
      expect(stepNames(recorded)).toEqual([
        "source.fetch",
        "records.replay",
        "records.annotations.get",
        // Filed before models is called: models is handed a Signed URL.
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
        "frame.crop",
        "source.decode",
        "redact.blur",
        "compose.cut",
        "store.put",
      ]);
      expect(recorded.framing).toMatchObject({ resolvedBy: "kart" });
      expect(recorded.matches).toMatchObject({ matches: [] });
    },
    TIMEOUT
  );

  it(
    "files the Output as a Crop with no Placement",
    async () => {
      const one = await stack();
      const { body } = await crop(one, KART);
      const outputs = await one.records.outputs.list({
        brand: BRAND,
        limit: 10,
      });

      expect(outputs.rows).toHaveLength(1);
      expect(outputs.rows[0]).toMatchObject({
        kind: "crop",
        placement: null,
        storeKey: body.output?.key,
      });
    },
    TIMEOUT
  );

  it(
    "answers one Face Report per face, hiding every face it cannot name",
    async () => {
      const one = await stack();
      const { body } = await crop(one, CREW);

      expect(body.faces?.map((f) => f.regionId)).toEqual(CREW_FACE_IDS);
      // The Brand enrolled nobody, so no face is named and every one is hidden.
      expect(body.faces?.map((f) => f.hidden)).toEqual(
        CREW_FACE_IDS.map(() => true)
      );
      expect(body.framing?.resolvedBy).toBe("face");
    },
    TIMEOUT
  );

  it(
    "answers the same JSON as the crop_image tool, with structuredContent",
    async () => {
      const one = await stack();
      const app = one.app();
      const http = await crop(one, KART, {}, app);
      const tool = await rpc(app, {
        method: "tools/call",
        params: {
          name: "crop_image",
          arguments: {
            brand: BRAND,
            width: WIDTH,
            height: HEIGHT,
            source: { hash: KART_HASH },
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
      const first = await crop(one, KART, {}, app);
      const again = await crop(one, KART, {}, app);
      const recorded = await call(one, again.body.call?.id);

      expect(again.body.output?.key).toBe(first.body.output?.key);
      expect(again.body.call?.replayed).toBe(true);
      expect(again.body.call?.id).not.toBe(first.body.call?.id);
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
    "is a different request at a different size, and cuts again",
    async () => {
      const one = await stack();
      const app = one.app();
      const tall = await crop(one, KART, {}, app);
      const square = await crop(one, KART, { height: WIDTH }, app);

      expect(square.body.call?.replayed).toBe(false);
      expect(square.body.output?.key).not.toBe(tall.body.output?.key);
      expect(square.body.output?.height).toBe(WIDTH);
    },
    TIMEOUT
  );
});

describe("the framing options a Crop carries", () => {
  it(
    "honours subjectArea: the window frame chooses moves with it",
    async () => {
      const one = await stack();
      const app = one.app();
      const centred = await crop(one, KART, {}, app);
      // The Subject pushed into the left third of the Crop, so frame has to
      // put more of the picture to its right inside the window.
      const left = await crop(
        one,
        KART,
        { subjectArea: { x: 0, y: 0.25, width: 0.34, height: 0.5 } },
        app
      );

      expect(left.status).toBe(200);
      expect(left.body.framing?.windowFraction).not.toEqual(
        centred.body.framing?.windowFraction
      );
      expect(left.body.output?.key).not.toBe(centred.body.output?.key);
    },
    TIMEOUT
  );

  it(
    "honours anchor, where nothing on the ladder yields and frame falls back",
    async () => {
      const one = await stack();
      const app = one.app();
      // A ladder of `match` alone, on a Brand that enrolled nobody: no rung
      // yields, so the anchor is the only thing left placing the window.
      const ladder = { pinTo: ["match"] };
      const topLeft = await crop(
        one,
        KART,
        { ...ladder, anchor: "top-left" },
        app
      );
      const bottomRight = await crop(
        one,
        KART,
        { ...ladder, anchor: "bottom-right" },
        app
      );

      expect(topLeft.status).toBe(200);
      expect(bottomRight.status).toBe(200);
      expect(topLeft.body.framing?.windowFraction.x).toBeLessThan(
        bottomRight.body.framing?.windowFraction.x ?? 0
      );
    },
    TIMEOUT
  );

  it(
    "honours format and quality: png in, PNG bytes out",
    async () => {
      const one = await stack();
      const { status, body } = await crop(one, KART, { format: "png" });

      expect(status).toBe(200);
      expect(body.output?.mime).toBe("image/png");
      expect(body.output?.key.endsWith(".png")).toBe(true);

      const stored = await one.store.get(body.output?.key ?? "");
      const head = (stored ?? new Uint8Array()).slice(0, 8);
      // The PNG signature, so the answer's mime is a fact of the bytes.
      expect([...head]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    },
    TIMEOUT
  );

  it(
    "is 400 invalid_request from the contract when the ladder names a rung twice",
    async () => {
      const one = await stack();
      const { status, body } = await crop(one, KART, {
        pinTo: ["kart", "kart"],
      });
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

describe("the Number Report", () => {
  /** The grid: four race numbers read, five karts, one face. */
  const GRID = KART_GRID_FILE;

  it(
    "reports every number read, with no Person until a Brand says whose it is",
    async () => {
      const one = await stack();
      const { status, body } = await crop(one, GRID);

      expect(status).toBe(200);
      // Read off the Annotation, so a number nobody enrolled is still
      // reported: that is how a Brand learns what to enrol.
      expect(body.numbers?.map((number) => number.label)).toEqual([
        "227",
        "24",
        "66",
        "21",
      ]);
      for (const number of body.numbers ?? []) {
        expect(number.personId).toBeUndefined();
        expect(typeof number.inFrame).toBe("boolean");
      }
      // Nobody was matched, so `kart` answers and the report is the only thing
      // that changed.
      expect(body.framing?.resolvedBy).toBe("kart");
    },
    TIMEOUT
  );

  it(
    "names the Person on their number, and frames their kart rather than the biggest",
    async () => {
      const one = await stack();
      const person = await one.records.people.create({
        brand: BRAND,
        name: "#24",
        numbers: ["24"],
      });

      const { status, body } = await crop(one, GRID, { pinTo: ["match"] });

      expect(status).toBe(200);
      // The whole point, end to end: the number read on the middle kart is
      // this Person's, and the window is on that kart.
      expect(
        body.numbers?.find((number) => number.label === "24")?.personId
      ).toBe(person.id);
      expect(body.framing?.resolvedBy).toBe("match");
      expect(body.framing?.leadRegionId).toBe("vehicle-3");
      // Not the row-wide detection, which is the largest `vehicle` box here.
      expect(body.framing?.leadRegionId).not.toBe("vehicle-5");

      // The Call keeps the number Match beside the face ones, as identify
      // answered it.
      const recorded = await call(one, body.call?.id);
      expect(recorded.matches).toMatchObject({
        matches: [
          {
            regionId: "vehicle-3",
            personId: person.id,
            by: "number",
            numberRegionId: "number-2",
          },
        ],
      });
    },
    TIMEOUT
  );

  it(
    "answers the same numbers on find_subjects, with no inFrame at all",
    async () => {
      const one = await stack();
      const person = await one.records.people.create({
        brand: BRAND,
        name: "#24",
        numbers: ["24"],
      });

      const found = await rpc(one.app(), {
        method: "tools/call",
        params: {
          name: "find_subjects",
          arguments: { brand: BRAND, source: { url: `${PHOTOS}/${GRID}` } },
        },
      });

      const numbers = (
        found.result as {
          structuredContent: {
            numbers: { label: string; personId?: string; inFrame?: boolean }[];
          };
        }
      ).structuredContent.numbers;

      expect(numbers.map((number) => number.label)).toEqual([
        "227",
        "24",
        "66",
        "21",
      ]);
      expect(numbers.find((number) => number.label === "24")?.personId).toBe(
        person.id
      );
      // No window was cut here, so there is no frame for a number to be in.
      for (const number of numbers) {
        expect(number.inFrame).toBeUndefined();
      }
    },
    TIMEOUT
  );
});
