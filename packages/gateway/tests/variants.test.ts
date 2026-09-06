// Template Variants through the whole pipeline (#228): compose plans every
// layout, frame chooses, the chosen one is drawn and named on the wire and on
// the Call.
import { templates } from "@meco/compose";
import { Annotation } from "@meco/contracts";
import { describe, expect, it } from "vitest";
import {
  CATALOGUE,
  fixtureAnnotation,
  fixtureBytes,
  KART_FILE,
  sha256,
} from "./annotations";
import {
  fakeModels,
  KEY,
  PHOTOS,
  SERVER_TIMING,
  TIMEOUT,
  useStacks,
  type Opened,
} from "./harness";

const stack = useStacks();

/** Held by the test Caller, and a Template with two Variants. */
const BRAND = "hopefamily";
const TEMPLATE = "hopefamily-story";
const PLACEMENT = "instagram/story";
const FIELDS = templates(BRAND).find((one) => one.id === TEMPLATE)?.example as
  Record<string, unknown> | undefined;

type Framing = {
  variant?: string;
  resolvedBy: string;
  satisfied: boolean;
  occlusionClear?: boolean;
  scale: number;
  lowResolution?: true;
  window: { width: number; height: number };
};

type Answer = {
  status: number;
  body: {
    output?: { key: string; bytes: number };
    call?: { id: string };
    framing?: Framing;
    error?: { code: string; message: string };
  };
};

async function post(
  one: Opened,
  route: string,
  body: Record<string, unknown>
): Promise<Answer> {
  const res = await one.app().request(route, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Answer["body"] };
}

const story = (one: Opened, file: string) =>
  post(one, "/v1/render", {
    brand: BRAND,
    template: TEMPLATE,
    placement: PLACEMENT,
    fields: FIELDS,
    source: { url: `${PHOTOS}/${file}` },
  });

/**
 * The kart photograph's bytes under a made-up Annotation: one `vehicle` Region
 * low in the 1600x1000 frame, which is the geometry of the production Call
 * that earned Variants (#228, `e0466f34`) on bytes the suite may hold. Low
 * enough to sit under the type block at the bottom, and above the band the
 * wordmark takes when it moves there. The fake models host answers it for
 * every `/annotate`.
 */
const lowKart = () => {
  const bytes = fixtureBytes(KART_FILE);
  const recorded = fixtureAnnotation(KART_FILE);
  const dfine = CATALOGUE.find((model) => model.name === "dfine");
  const annotation = Annotation.parse({
    schema: 1,
    hash: sha256(bytes),
    mime: "image/jpeg",
    width: recorded.width,
    height: recorded.height,
    producedBy: CATALOGUE,
    regions: [
      {
        id: "vehicle-1",
        kind: "vehicle",
        label: "motorbike",
        box: { x: 0.35, y: 0.55, width: 0.3, height: 0.28 },
        score: 0.9,
        model: dfine,
      },
    ],
  });
  return fakeModels({
    annotate: async () =>
      Response.json(annotation, {
        headers: { "server-timing": SERVER_TIMING },
      }),
  });
};

describe("a Template with two Variants", () => {
  it(
    "names the Variant frame chose on the wire, and keeps caption-bottom when neither layout is clearer",
    async () => {
      // The recording: the kart Subject of `on-track-dark-visor.jpg` fills the
      // upper half of a 563x1000 column and is wider than it, so it clips
      // under either layout and touches a block in both — the wordmark at the
      // top, or the type there instead. Nothing separates the two and the
      // Template's first Variant stands.
      const one = await stack();
      const { status, body } = await story(one, KART_FILE);

      expect(status).toBe(200);
      expect(body.framing?.resolvedBy).toBe("kart");
      expect(body.framing?.variant).toBe("caption-bottom");
      expect(body.framing?.occlusionClear).toBe(false);
    },
    TIMEOUT
  );

  it(
    "moves the caption to the top for a kart in the bottom third, and renders that layout",
    async () => {
      const one = await stack({ models: lowKart() });
      const { status, body } = await story(one, KART_FILE);

      expect(status).toBe(200);
      expect(body.framing?.resolvedBy).toBe("kart");
      expect(body.framing?.variant).toBe("caption-top");
      expect(body.framing?.occlusionClear).toBe(true);
      expect(body.output?.bytes).toBeGreaterThan(0);

      // The Call keeps the Framing verbatim, Variant included, which is what
      // the Call View reads.
      const call = await one.records.calls.get(body.call?.id ?? "");
      expect(call?.framing).toMatchObject({ variant: "caption-top" });
    },
    TIMEOUT
  );

  it(
    "says how far the picture is upscaled",
    async () => {
      // 1600x1000 into a 1080x1920 story is a 563x1000 column: 1920 / 1000.
      const one = await stack();
      const { body } = await story(one, KART_FILE);

      expect(body.framing?.window).toMatchObject({ width: 563, height: 1000 });
      expect(body.framing?.scale).toBeCloseTo(1.92, 3);
      expect(body.framing?.lowResolution).toBe(true);
    },
    TIMEOUT
  );
});

describe("a Crop", () => {
  it(
    "has no Template and so no Variant, and a scale below one on a big picture",
    async () => {
      const one = await stack();
      const { status, body } = await post(one, "/v1/crop", {
        brand: BRAND,
        source: { url: `${PHOTOS}/${KART_FILE}` },
        width: 400,
        height: 400,
      });

      expect(status).toBe(200);
      expect(body.framing).toBeDefined();
      expect("variant" in (body.framing ?? {})).toBe(false);
      expect(body.framing?.scale).toBeCloseTo(0.4, 6);
      expect("lowResolution" in (body.framing ?? {})).toBe(false);
    },
    TIMEOUT
  );
});
