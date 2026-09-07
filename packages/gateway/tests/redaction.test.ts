// The Redaction Policy through the app: four levels, first set wins, and an
// absent level falls to the next one rather than to the default (#249).
//
// Every row goes through `createApp().request` on the real pipeline, because
// the rule is only worth anything if it survives the whole door — the input
// schema, the Brand row, the Template registry and the FramingRequest the
// contract validates. A resolver test alone would pass with the levels wired
// to nothing.
//
// Each row carries its own Fields (a Render) or its own size (a Crop), so no
// two rows share a Request Hash. Two rows that differed only in the Brand's
// default would otherwise be one Replay of the other — which is the documented
// behaviour, and is proved on its own below rather than by accident here.
import { describe, expect, it } from "vitest";
import {
  KEY,
  NOT_HELD,
  PHOTOS,
  TIMEOUT,
  useStacks,
  type Opened,
} from "./harness";
import { REDACTION_TEMPLATES } from "./redaction-template";

const stack = useStacks();

const FILE = "artemis-2-crew.jpg";
const BRAND = "hopefamily";
const PLACEMENT = "instagram/story";
/** Declares `redaction: { blurUnknownFaces: false }`. */
const UNBLURRED = "hopefamily-unblurred";
/** Declares nothing, so the Brand's default answers next. */
const SILENT = "hopefamily-silent";

type Framing = {
  readonly redaction?: { blurUnknownFaces: boolean; from: string };
};
type Face = { readonly hidden: boolean };
type Answer = {
  status: number;
  body: {
    framing?: Framing;
    faces?: Face[];
    error?: { code: string; message: string };
  };
};

const post = async (
  one: Opened,
  path: string,
  body: Record<string, unknown>,
  app = one.app({ templates: REDACTION_TEMPLATES })
): Promise<Answer> => {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Answer["body"] };
};

const source = { url: `${PHOTOS}/${FILE}` };

/** What a level says, as the table writes it. `undefined` is "says nothing". */
type Level = boolean | undefined;

const policy = (value: Level) =>
  value === undefined ? {} : { redaction: { blurUnknownFaces: value } };

/**
 * The Brand's rung, set through the Operation rather than through records, so
 * the table exercises the same path a caller would.
 */
async function setBrandRedaction(one: Opened, value: Level): Promise<void> {
  const app = one.app({ templates: REDACTION_TEMPLATES });
  const res = await app.request(`/v1/brands/${BRAND}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      redaction: value === undefined ? null : { blurUnknownFaces: value },
    }),
  });
  expect(res.status).toBe(200);
}

/**
 * Every combination of set and absent for a Render: three requests, two
 * Templates, three Brands. The expected level is the first that says anything,
 * and `default` when none does.
 */
const RENDER_TABLE: readonly {
  request: Level;
  template: string;
  brand: Level;
  expect: { blurUnknownFaces: boolean; from: string };
}[] = [true, false, undefined].flatMap((request) =>
  [UNBLURRED, SILENT].flatMap((template) =>
    [true, false, undefined].map((brand) => {
      // The Template rung, read off the Template the row names. Written out
      // here rather than looked up, so the table states the expectation
      // instead of re-deriving it from the code under test.
      const declared = template === UNBLURRED ? false : undefined;
      const [from, blurUnknownFaces] =
        request !== undefined
          ? (["request", request] as const)
          : declared !== undefined
            ? (["template", declared] as const)
            : brand !== undefined
              ? (["brand", brand] as const)
              : (["default", true] as const);
      return { request, template, brand, expect: { blurUnknownFaces, from } };
    })
  )
);

/** The same, without the Template rung: a Crop has no Template. */
const CROP_TABLE: readonly {
  request: Level;
  brand: Level;
  expect: { blurUnknownFaces: boolean; from: string };
}[] = [true, false, undefined].flatMap((request) =>
  [true, false, undefined].map((brand) => {
    const [from, blurUnknownFaces] =
      request !== undefined
        ? (["request", request] as const)
        : brand !== undefined
          ? (["brand", brand] as const)
          : (["default", true] as const);
    return { request, brand, expect: { blurUnknownFaces, from } };
  })
);

const say = (value: Level) => (value === undefined ? "absent" : String(value));

describe("the Redaction Policy resolves request → template → brand → default", () => {
  it(
    "render: every combination resolves to the first level that set one",
    async () => {
      const one = await stack();

      for (const [index, row] of RENDER_TABLE.entries()) {
        await setBrandRedaction(one, row.brand);

        const answer = await post(one, "/v1/render", {
          brand: BRAND,
          template: row.template,
          placement: PLACEMENT,
          // Unique per row, so no row replays another's Output.
          fields: { caption: `row ${index}` },
          source,
          ...policy(row.request),
        });

        const where = `request ${say(row.request)}, template ${row.template}, brand ${say(row.brand)}`;
        expect(answer.status, `${where}: ${JSON.stringify(answer.body.error)}`).toBe(200);
        expect(answer.body.framing?.redaction, where).toEqual(row.expect);

        // Not just the report: whether a face was actually hidden is what the
        // policy is for. Every face in this photograph is a stranger to this
        // Brand, so the whole list follows the policy.
        const faces = answer.body.faces ?? [];
        expect(faces.length, `${where}: the fixture has faces`).toBeGreaterThan(0);
        expect(
          faces.every((face) => face.hidden),
          `${where}: redact ran with the resolved policy`
        ).toBe(row.expect.blurUnknownFaces);
      }
    },
    TIMEOUT * 4
  );

  it(
    "crop: no Template, so every combination walks request → brand → default",
    async () => {
      const one = await stack();

      for (const [index, row] of CROP_TABLE.entries()) {
        await setBrandRedaction(one, row.brand);

        const answer = await post(one, "/v1/crop", {
          brand: BRAND,
          source,
          // Unique per row, for the same reason the Fields are.
          width: 400 + index,
          height: 400,
          ...policy(row.request),
        });

        const where = `request ${say(row.request)}, brand ${say(row.brand)}`;
        expect(answer.status, `${where}: ${JSON.stringify(answer.body.error)}`).toBe(200);
        expect(answer.body.framing?.redaction, where).toEqual(row.expect);

        const faces = answer.body.faces ?? [];
        expect(faces.length, `${where}: the fixture has faces`).toBeGreaterThan(0);
        expect(
          faces.every((face) => face.hidden),
          `${where}: redact ran with the resolved policy`
        ).toBe(row.expect.blurUnknownFaces);
      }
    },
    TIMEOUT * 4
  );

  it(
    "a Brand that changes its default does not invalidate an Output already made",
    async () => {
      const one = await stack();
      const body = {
        brand: BRAND,
        template: SILENT,
        placement: PLACEMENT,
        fields: { caption: "the same request twice" },
        source,
      };

      await setBrandRedaction(one, false);
      const before = await post(one, "/v1/render", body);
      expect(before.body.framing?.redaction).toEqual({
        blurUnknownFaces: false,
        from: "brand",
      });

      // The Request Hash covers the request as sent, and the Brand's default
      // is not part of it. So the second call is a Replay and answers the
      // Framing the first one stored, default and all. A Brand that wants a
      // fresh Output re-sends with the policy in the request.
      await setBrandRedaction(one, true);
      const after = await post(one, "/v1/render", body);
      expect(after.body.framing?.redaction).toEqual({
        blurUnknownFaces: false,
        from: "brand",
      });
    },
    TIMEOUT * 2
  );
});

describe("set_brand_redaction", () => {
  const patch = async (
    one: Opened,
    brand: string,
    redaction: unknown
  ): Promise<Response> =>
    one.app().request(`/v1/brands/${brand}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ redaction }),
    });

  it(
    "answers the Brand with what it set, and null clears it",
    async () => {
      const one = await stack();

      const set = await patch(one, BRAND, { blurUnknownFaces: false });
      expect(set.status).toBe(200);
      expect(await set.json()).toEqual({
        id: BRAND,
        name: "Hope Family",
        redaction: { blurUnknownFaces: false },
      });

      const cleared = await patch(one, BRAND, null);
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toMatchObject({ redaction: null });
    },
    TIMEOUT
  );

  it(
    "is behind the Brand Wall, and the Brand it names is never written",
    async () => {
      const one = await stack();

      const refused = await patch(one, NOT_HELD, { blurUnknownFaces: false });
      expect(refused.status).toBe(403);
      expect(await one.records.brands.get(NOT_HELD)).toMatchObject({
        redaction: null,
      });
    },
    TIMEOUT
  );

  it(
    "refuses a body that is neither a policy nor null",
    async () => {
      const one = await stack();

      // `{}` is not "leave it alone": the field is required, so a PATCH with
      // one thing to change always says what it is changing it to.
      expect((await patch(one, BRAND, {})).status).toBe(400);
      expect((await patch(one, BRAND, { blurUnknownFaces: "yes" })).status).toBe(
        400
      );
      expect((await patch(one, BRAND, { blurEverything: true })).status).toBe(
        400
      );
    },
    TIMEOUT
  );

  it(
    "shows the defaults on list_brands and list_templates",
    async () => {
      const one = await stack();
      await patch(one, BRAND, { blurUnknownFaces: false });
      const app = one.app({ templates: REDACTION_TEMPLATES });

      const brands = (await (
        await app.request("/v1/brands", {
          headers: { Authorization: `Bearer ${KEY}` },
        })
      ).json()) as { items: { id: string; redaction: unknown }[] };
      expect(
        brands.items.find((item) => item.id === BRAND)?.redaction
      ).toEqual({ blurUnknownFaces: false });

      const listed = (await (
        await app.request(`/v1/templates?brand=${BRAND}`, {
          headers: { Authorization: `Bearer ${KEY}` },
        })
      ).json()) as { items: { id: string; redaction?: unknown }[] };
      const byId = new Map(listed.items.map((item) => [item.id, item]));
      expect(byId.get(UNBLURRED)?.redaction).toEqual({
        blurUnknownFaces: false,
      });
      // Absent, not `null`: a Template with no opinion says nothing at all.
      expect(byId.get(SILENT)).not.toHaveProperty("redaction");
    },
    TIMEOUT
  );
});
