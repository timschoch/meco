/**
 * People over both Doors: create, enrol, list, erase.
 *
 * Every check runs through `createApp(...).request(...)`, over records on
 * PGlite, the in-memory store and the real identify, with only the model and
 * the photograph host faked. `fakeModels` answers `/annotate` from the
 * committed fixture Annotations, keyed by the SHA-256 of the bytes it was sent,
 * and `fakePhotos` serves those bytes; a photograph identify has to refuse is
 * invented here, because `fixtures/faces/` holds none.
 */
import { NOT_A_FACE_PRINTS } from "@meco/identify";
import { peoplePrefix } from "@meco/records";
import { MAX_OBJECT_BYTES } from "@meco/store";
import { describe, expect, it } from "vitest";
import {
  CATALOGUE,
  annotationByHash,
  fixtureAnnotation,
  fixtureBytes,
  sha256,
} from "./annotations";
import {
  HELD,
  KEY,
  MAX_BINDING_BODY_BYTES,
  NOT_HELD,
  type Opened,
  PHOTOS,
  SERVER_TIMING,
  TIMEOUT,
  fakeModels,
  fakePhotos,
  rpc,
  useStacks,
} from "./harness";

const stack = useStacks();

/** The app both Doors are reached through, as `open()` builds one. */
type App = ReturnType<Opened["app"]>;

const withKey = { headers: { Authorization: `Bearer ${KEY}` } };

const BRAND = HELD[0];
const CONSENT = "2026-01-01T00:00:00.000Z";

/** What a Reference Photo is meant to look like, and what it is not. */
const ONE_FACE = "astronaut-portrait.jpg";
const MANY_FACES = "soyuz-crew.jpg";

const oneFace = fixtureAnnotation(ONE_FACE);
const [face] = oneFace.regions;
if (face?.facePrint === undefined) {
  throw new Error(`${ONE_FACE} has no printed face Region`);
}
const print = face.facePrint;

/**
 * A photograph this suite invents, one per `IdentifyError` code a Reference
 * Photo can be refused with, with the status `docs/specs/gateway.md` gives that
 * code. Each is the one-face fixture with one fact changed, so what the check
 * measures is the mapping and not the fixture. `fixtures/faces/` holds no
 * photograph that fails these gates, which is why they are made here.
 */
const CRAFTED = [
  {
    name: "no-face",
    code: "no_face",
    status: 422,
    edit: { regions: [] },
  },
  {
    name: "no-print",
    code: "no_print",
    status: 422,
    edit: { regions: [{ ...face, facePrint: undefined }] },
  },
  {
    name: "other-model",
    code: "other_model",
    status: 422,
    edit: {
      regions: [
        {
          ...face,
          facePrint: { ...print, model: { name: "arcface", version: "1" } },
        },
      ],
    },
  },
  {
    name: "too-small",
    code: "too_small",
    status: 422,
    edit: {
      regions: [{ ...face, box: { ...face.box, width: 0.005, height: 0.005 } }],
    },
  },
  {
    name: "not-a-face",
    code: "not_a_face",
    status: 422,
    edit: {
      regions: [
        {
          ...face,
          facePrint: {
            ...print,
            // The back of a crash helmet, verbatim: the print that taught the
            // rule (ADR-0003, amendment) scored against itself is 1.0.
            vector: [...(NOT_A_FACE_PRINTS[0]?.vector ?? [])],
          },
        },
      ],
    },
  },
] as const;

/**
 * A crafted photograph big enough that the platform would refuse it as a body
 * on the service binding. The fake models host enforces that bound, so a
 * Reference Photo this size only enrols while `enrol` hands over a URL.
 */
const OVER_THE_CAP = "over-the-cap";

/**
 * The bytes a crafted photograph is served as. Its name is enough, except for
 * the over-the-cap one, which has to actually be that big.
 */
const craftedBytes = (name: string): Uint8Array => {
  const named = new TextEncoder().encode(`crafted:${name}`);
  if (name !== OVER_THE_CAP) return named;
  const padded = new Uint8Array(MAX_BINDING_BODY_BYTES + 1);
  padded.set(named);
  return padded;
};

const craftedAnnotation = (name: string): unknown => {
  const base = { ...oneFace, producedBy: CATALOGUE, hash: sha256(craftedBytes(name)) };
  // The over-the-cap photograph is not a refusal: it is an ordinary one face,
  // and only its size is the point.
  if (name === OVER_THE_CAP) return base;
  const one = CRAFTED.find((each) => each.name === name);
  if (one === undefined) throw new Error(`no crafted photograph ${name}`);
  return { ...base, ...one.edit };
};

/** Every crafted photograph the fake hosts answer for, refusals and not. */
const CRAFTED_NAMES: readonly string[] = [
  ...CRAFTED.map((one) => one.name),
  OVER_THE_CAP,
];

/**
 * models, answering the committed fixtures and this suite's invented ones. The
 * `hash_mismatch` check inside the client is what keeps the invented ones
 * honest: an Annotation filed under the wrong hash is refused there, not here.
 */
const models = () =>
  fakeModels({
    annotate: async (_request, body) => {
      if (body === null) {
        return Response.json(
          {
            error: {
              code: "source_unfetchable",
              message: "the Signed URL hands over nothing",
            },
          },
          { status: 502 }
        );
      }
      const hash = sha256(body);
      const crafted = CRAFTED_NAMES.find(
        (name) => sha256(craftedBytes(name)) === hash
      );
      if (crafted !== undefined) {
        return Response.json(craftedAnnotation(crafted), {
          headers: { "server-timing": SERVER_TIMING },
        });
      }
      const known = annotationByHash(hash);
      if (known === null) {
        return Response.json(
          { error: { code: "undecodable", message: "not a fixture" } },
          { status: 400 }
        );
      }
      return Response.json(known, {
        headers: { "server-timing": SERVER_TIMING },
      });
    },
  });

/**
 * The photograph host: the fixtures, this suite's invented photographs, and
 * three answers no photograph gives — over-size by header, over-size by
 * stream, and a redirect down to http — for the three refusals the source
 * resolver owns.
 */
const photos = () => {
  const fixtures = fakePhotos();
  const seen: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const name = decodeURIComponent(url.pathname.slice(1));
    seen.push(url.href);

    if (name === "redirect-to-http") {
      return new Response(null, {
        status: 302,
        headers: { location: `http://photos.test/${ONE_FACE}` },
      });
    }
    if (name === "huge-by-header") {
      // A small body under an over-size `Content-Length`. A resolver that read
      // the body would find a perfectly ordinary photograph and enrol it, so a
      // 413 can only have come from the header.
      return new Response(fixtureBytes(ONE_FACE), {
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(MAX_OBJECT_BYTES + 1),
        },
      });
    }
    if (name === "huge-by-stream") {
      // No Content-Length at all, and more bytes than the limit: only counting
      // the stream can refuse this one.
      const chunk = new Uint8Array(1 << 20);
      let sent = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (sent > MAX_OBJECT_BYTES) return controller.close();
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
        { headers: { "content-type": "image/jpeg" } }
      );
    }
    if (CRAFTED_NAMES.includes(name)) {
      return new Response(craftedBytes(name), {
        headers: { "content-type": "image/jpeg" },
      });
    }
    return fixtures.fetch(input, init);
  };
  return { seen, fetch };
};

const sourceUrl = (name: string): string => `${PHOTOS}/${name}`;

/** A stack whose models and photograph host both know this suite's fixtures. */
const enrolling = async () => {
  const one = await stack({ models: models(), photos: photos() });
  return { one, app: one.app() };
};

/** That stack, plus a Person of the held Brand with nothing enrolled yet. */
const somebody = async () => {
  const { one, app } = await enrolling();
  const person = await one.records.people.create({ brand: BRAND, name: "Ada" });
  return { one, app, person };
};

const post = async (app: App, path: string, body: unknown): Promise<Response> =>
  app.request(path, {
    method: "POST",
    headers: { ...withKey.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("add_person", () => {
  it(
    "creates a Person under a held Brand and lists it back",
    async () => {
      const { app } = await enrolling();

      const res = await post(app, "/v1/people", { brand: BRAND, name: "Ada" });

      expect(res.status).toBe(200);
      const person = (await res.json()) as { id: string; brand: string };
      expect(person).toMatchObject({ brand: BRAND, name: "Ada" });
      expect(person.id).toMatch(/^[0-9a-f-]{36}$/);

      const listed = await (
        await app.request(`/v1/people?brand=${BRAND}`, withKey)
      ).json();
      expect(listed).toEqual({ items: [{ ...person, photos: [] }] });
    },
    TIMEOUT
  );

  it(
    "refuses a Brand the Caller does not hold as 403 brand_not_held, and writes no row",
    async () => {
      const { one, app } = await enrolling();

      const res = await post(app, "/v1/people", {
        brand: NOT_HELD,
        name: "Ada",
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "brand_not_held" },
      });
      // The wall stands in front of the handler, so the refusal is also the
      // proof that `people.create` never ran.
      await expect(one.records.people.list(NOT_HELD)).resolves.toEqual([]);
    },
    TIMEOUT
  );
});

describe("erase_person", () => {
  it(
    "answers records' Erasure with the empty listing, leaves no Person, and writes an erase Call",
    async () => {
      const { one, app, person } = await somebody();

      const res = await app.request(`/v1/people/${person.id}?brand=${BRAND}`, {
        ...withKey,
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        person: person.id,
        erased: true,
        photos: 0,
        files: [],
        keys: [],
        remaining: [],
      });

      const listed = await (
        await app.request(`/v1/people?brand=${BRAND}`, withKey)
      ).json();
      expect(listed).toEqual({ items: [] });

      const calls = await one.records.calls.list({ brand: BRAND, limit: 10 });
      expect(calls.rows.map((call) => [call.kind, call.status])).toEqual([
        ["erase", "ok"],
      ]);
    },
    TIMEOUT
  );

  it(
    "answers 404 not_found for a Person of another Brand, word for word as for an id nobody has",
    async () => {
      const { one, app } = await enrolling();
      // A Brand this key does hold, so the wall lets the request through and
      // the only thing left to refuse it is the Person's own Brand.
      const elsewhere = await one.records.people.create({
        brand: HELD[1],
        name: "Ada",
      });

      const other = await app.request(
        `/v1/people/${elsewhere.id}?brand=${BRAND}`,
        { ...withKey, method: "DELETE" }
      );
      const unknown = await app.request(
        `/v1/people/${crypto.randomUUID()}?brand=${BRAND}`,
        { ...withKey, method: "DELETE" }
      );

      expect([other.status, unknown.status]).toEqual([404, 404]);
      // The same words, not merely the same status: an answer that said "this
      // Person belongs to another Brand" would tell a caller which ids exist
      // somewhere else. Only the id each request named may differ, so both
      // bodies are compared with theirs blanked out.
      const [a, b] = await Promise.all([other.json(), unknown.json()]);
      const blanked = (body: unknown): string =>
        JSON.stringify(body).replaceAll(/[0-9a-f-]{36}/g, "<person>");
      expect(blanked(a)).toBe(blanked(b));
      expect(a).toMatchObject({ error: { code: "not_found" } });
      // And the row is still there, which is what makes the 404 a refusal
      // rather than a silent success.
      await expect(
        one.records.people.get(HELD[1], elsewhere.id)
      ).resolves.toMatchObject({ id: elsewhere.id });
    },
    TIMEOUT
  );
});

describe("add_reference_photo", () => {
  it(
    "enrols a Reference Photo the service binding would refuse as a body",
    async () => {
      // The whole point of #235. The fake models host refuses a raw-bytes body
      // above the platform's measured cap, exactly as the platform does, so
      // this passes only while `enrol` files the photograph and hands over a
      // Signed URL instead. Post the bytes and it is a 502 `bad_response`.
      const { one, app, person } = await somebody();
      const bytes = craftedBytes(OVER_THE_CAP);
      expect(bytes.byteLength).toBeGreaterThan(MAX_BINDING_BODY_BYTES);

      const res = await post(app, `/v1/people/${person.id}/photos`, {
        brand: BRAND,
        source: { url: sourceUrl(OVER_THE_CAP) },
        consentAt: CONSENT,
      });

      // Only the outcome, so the platform's cap is the one thing that can
      // fail this. Which key the URL named is the check below.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { photo?: { hash?: string } };
      expect(body.photo?.hash).toBe(sha256(bytes));
      expect(await one.store.list(`people/${BRAND}/${person.id}`)).toHaveLength(
        1
      );
    },
    TIMEOUT
  );

  it(
    "hands models a Signed URL for the key it filed the photograph under",
    async () => {
      // The other half of the carrier: not that a big photograph got through,
      // but that what models was given names the object identify wrote, under
      // the Person's prefix and nowhere else.
      const { one, app, person } = await somebody();

      await post(app, `/v1/people/${person.id}/photos`, {
        brand: BRAND,
        source: { url: sourceUrl(ONE_FACE) },
        consentAt: CONSENT,
      });

      const stored = await one.store.list(`people/${BRAND}/${person.id}`);
      expect(stored).toHaveLength(1);
      expect(one.modelsFetched).toHaveLength(1);
      expect(new URL(one.modelsFetched[0]!).pathname).toBe(
        `/${stored[0]?.key ?? ""}`
      );
    },
    TIMEOUT
  );

  it(
    "enrols from an https URL and answers the Reference Photo without its Face Print",
    async () => {
      const { one, app, person } = await somebody();

      const res = await post(app, `/v1/people/${person.id}/photos`, {
        brand: BRAND,
        source: { url: sourceUrl(ONE_FACE) },
        consentAt: CONSENT,
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        status: "enrolled",
        photo: {
          id: expect.any(String),
          personId: person.id,
          hash: sha256(fixtureBytes(ONE_FACE)),
          regionId: "face-1",
          consentAt: CONSENT,
          createdAt: expect.any(String),
        },
      });

      // The row that proves the print was computed and kept, which is the
      // thing the answer above must not carry.
      const [stored] = await one.records.people.list(BRAND);
      expect(stored?.photos).toHaveLength(1);
      expect(stored?.photos[0]?.facePrint.vector).toHaveLength(
        print.vector.length
      );

      const calls = await one.records.calls.list({ brand: BRAND, limit: 10 });
      expect(calls.rows.map((call) => [call.kind, call.status])).toEqual([
        ["enrol", "ok"],
      ]);
      expect(calls.rows[0]?.sourceHash).toBe(sha256(fixtureBytes(ONE_FACE)));
      // models' own clock, filed as Steps on this Call like every other stage.
      expect(calls.rows[0]?.steps.map((step) => step.name)).toEqual(
        expect.arrayContaining([
          "source.fetch",
          "identify.enrol",
          "models.edgeface",
        ])
      );
    },
    TIMEOUT
  );

  it(
    "carries no Face Print into the listing, by any name, at any depth",
    async () => {
      const { app, person } = await somebody();
      await post(app, `/v1/people/${person.id}/photos`, {
        brand: BRAND,
        source: { url: sourceUrl(ONE_FACE) },
        consentAt: CONSENT,
      });

      const res = await app.request(`/v1/people?brand=${BRAND}`, withKey);
      const body: unknown = await res.json();

      // Walked rather than asserted field by field: what must not be there is
      // a 512-float vector, whatever key it arrives under, and a check that
      // only names `facePrint` would pass a rename.
      const found: string[] = [];
      const walk = (node: unknown, path: string): void => {
        if (Array.isArray(node)) {
          if (node.length === print.vector.length) found.push(path);
          node.forEach((child, i) => walk(child, `${path}[${i}]`));
          return;
        }
        if (typeof node === "object" && node !== null) {
          for (const [key, child] of Object.entries(node)) {
            if (key.toLowerCase().includes("print")) {
              found.push(`${path}.${key}`);
            }
            walk(child, `${path}.${key}`);
          }
        }
      };
      walk(body, "$");
      expect(found).toEqual([]);
      expect(JSON.stringify(body)).toContain(sha256(fixtureBytes(ONE_FACE)));
    },
    TIMEOUT
  );

  it(
    "asks which face when the photograph has several, and stores nothing while it asks",
    async () => {
      const { one, app, person } = await somebody();

      const res = await post(app, `/v1/people/${person.id}/photos`, {
        brand: BRAND,
        source: { url: sourceUrl(MANY_FACES) },
        consentAt: CONSENT,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        faces: { regionId: string; pixels: number }[];
      };
      expect(body.status).toBe("choose");
      expect(body.faces).toHaveLength(
        fixtureAnnotation(MANY_FACES).regions.length
      );
      // Largest first, so an enroller picking the obvious face picks the first.
      expect(body.faces.map((each) => each.pixels)).toEqual(
        [...body.faces.map((each) => each.pixels)].sort((a, b) => b - a)
      );

      const [stored] = await one.records.people.list(BRAND);
      expect(stored?.photos).toEqual([]);
      await expect(
        one.store.list(peoplePrefix(BRAND, person.id))
      ).resolves.toEqual([]);
    },
    TIMEOUT
  );

  it(
    "files the Reference Photo under the media type the source announced",
    async () => {
      const { one, app, person } = await somebody();
      const bytes = fixtureBytes(ONE_FACE);
      const hash = sha256(bytes);
      // The same bytes, filed by this Brand as a PNG. What identify writes
      // them under is the type the source carries, not one the door assumed:
      // a Store Key ending `.jpg` here would be a lie about the object.
      const put = await one.store.put("sources", bytes, "image/png");
      await one.records.files.ensure({
        hash,
        mime: "image/png",
        width: oneFace.width,
        height: oneFace.height,
        bytes: bytes.byteLength,
        storeKey: put.key,
      });
      await one.records.sources.hold(BRAND, hash);

      const res = await post(app, `/v1/people/${person.id}/photos`, {
        brand: BRAND,
        source: { hash },
        consentAt: CONSENT,
      });

      expect(res.status).toBe(200);
      const [stored] = await one.records.people.list(BRAND);
      expect(stored?.photos[0]?.storeKey).toMatch(/\.png$/);
    },
    TIMEOUT
  );

  it(
    "enrols the face the caller names, when it names one",
    async () => {
      const { app, person } = await somebody();

      const res = await post(app, `/v1/people/${person.id}/photos`, {
        brand: BRAND,
        source: { url: sourceUrl(MANY_FACES) },
        consentAt: CONSENT,
        regionId: "face-2",
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        status: "enrolled",
        photo: { regionId: "face-2" },
      });
    },
    TIMEOUT
  );

  it(
    "resolves a Source Reference this Brand already holds, and refuses one it does not",
    async () => {
      const { one, app, person } = await somebody();
      const bytes = fixtureBytes(ONE_FACE);
      const hash = sha256(bytes);
      // What `annotate` leaves behind for a URL this Brand sent before: bytes
      // in the store, a File, and the Brand's Source Hold.
      const put = await one.store.put("sources", bytes, "image/jpeg");
      await one.records.files.ensure({
        hash,
        mime: "image/jpeg",
        width: oneFace.width,
        height: oneFace.height,
        bytes: bytes.byteLength,
        storeKey: put.key,
      });

      const unheld = await post(app, `/v1/people/${person.id}/photos`, {
        brand: BRAND,
        source: { hash },
        consentAt: CONSENT,
      });
      expect(unheld.status).toBe(404);
      await expect(unheld.json()).resolves.toMatchObject({
        error: { code: "not_found" },
      });

      await one.records.sources.hold(BRAND, hash);
      const held = await post(app, `/v1/people/${person.id}/photos`, {
        brand: BRAND,
        source: { hash },
        consentAt: CONSENT,
      });
      expect(held.status).toBe(200);
      await expect(held.json()).resolves.toMatchObject({
        status: "enrolled",
        photo: { hash },
      });
    },
    TIMEOUT
  );

  it(
    "refuses an enrolment with no consent date as 400 consent_required, and stores nothing",
    async () => {
      const { one, app, person } = await somebody();

      const res = await post(app, `/v1/people/${person.id}/photos`, {
        brand: BRAND,
        source: { url: sourceUrl(ONE_FACE) },
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "consent_required" },
      });
      await expect(
        one.store.list(peoplePrefix(BRAND, person.id))
      ).resolves.toEqual([]);
      // A refusal is a Call too, so the owner can read back that somebody
      // tried to enrol without a consent date.
      const calls = await one.records.calls.list({ brand: BRAND, limit: 10 });
      expect(calls.rows.map((call) => [call.kind, call.status])).toEqual([
        ["enrol", "failed"],
      ]);
      expect(calls.rows[0]?.error).toMatchObject({
        module: "identify",
        code: "consent_required",
      });
    },
    TIMEOUT
  );

  it(
    "refuses a Person of another Brand as 404 unknown_person",
    async () => {
      const { one, app } = await enrolling();
      const elsewhere = await one.records.people.create({
        brand: HELD[1],
        name: "Ada",
      });

      const res = await post(app, `/v1/people/${elsewhere.id}/photos`, {
        brand: BRAND,
        source: { url: sourceUrl(ONE_FACE) },
        consentAt: CONSENT,
      });

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "unknown_person" },
      });
    },
    TIMEOUT
  );

  it(
    "refuses a regionId that is no face in this photograph as 422 unknown_region",
    async () => {
      const { app, person } = await somebody();

      const res = await post(app, `/v1/people/${person.id}/photos`, {
        brand: BRAND,
        source: { url: sourceUrl(ONE_FACE) },
        consentAt: CONSENT,
        regionId: "face-9",
      });

      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "unknown_region" },
      });
    },
    TIMEOUT
  );

  it.each(CRAFTED)(
    "maps identify's $code to $status and stores nothing",
    async ({ name, code, status }) => {
      const { one, app, person } = await somebody();

      const res = await post(app, `/v1/people/${person.id}/photos`, {
        brand: BRAND,
        source: { url: sourceUrl(name) },
        consentAt: CONSENT,
      });

      expect(res.status).toBe(status);
      await expect(res.json()).resolves.toMatchObject({ error: { code } });
      await expect(
        one.store.list(peoplePrefix(BRAND, person.id))
      ).resolves.toEqual([]);
    },
    TIMEOUT
  );

  it(
    "answers the MCP tool with the same JSON, and refuses a Brand the key does not hold there too",
    async () => {
      const { app, person } = await somebody();

      const answer = await rpc(app, {
        method: "tools/call",
        params: {
          name: "add_reference_photo",
          arguments: {
            id: person.id,
            brand: BRAND,
            source: { url: sourceUrl(ONE_FACE) },
            consentAt: CONSENT,
          },
        },
      });
      const text = (answer.result as { content: { text: string }[] }).content[0]
        ?.text;
      const enrolled = JSON.parse(text ?? "") as { status: string };
      expect(enrolled.status).toBe("enrolled");
      expect(answer.result).toMatchObject({ structuredContent: enrolled });

      const walled = await rpc(app, {
        method: "tools/call",
        params: {
          name: "add_reference_photo",
          arguments: {
            id: person.id,
            brand: NOT_HELD,
            source: { url: sourceUrl(ONE_FACE) },
            consentAt: CONSENT,
          },
        },
      });
      expect(walled.result).toMatchObject({ isError: true });
      const refusal = (walled.result as { content: { text: string }[] })
        .content[0]?.text;
      expect(JSON.parse(refusal ?? "")).toMatchObject({
        error: { code: "brand_not_held" },
      });

      // The same rows through the other Door: one table, so the listing has to
      // show the enrolment the tool just made.
      const listed = await (
        await app.request(`/v1/people?brand=${BRAND}`, withKey)
      ).json();
      expect(listed).toMatchObject({
        items: [{ photos: [{ regionId: "face-1" }] }],
      });
    },
    TIMEOUT
  );
});

describe("the Source Reference a Reference Photo names", () => {
  const refuse = async (name: string) => {
    const { one, app, person } = await somebody();
    const before = one.modelsSeen.length;
    const res = await post(app, `/v1/people/${person.id}/photos`, {
      brand: BRAND,
      source: { url: sourceUrl(name) },
      consentAt: CONSENT,
    });
    return { res, body: await res.json(), ran: one.modelsSeen.slice(before) };
  };

  it(
    "refuses a photograph over MAX_OBJECT_BYTES by Content-Length, without reading the body",
    async () => {
      // The host serves an ordinary photograph under a lying `Content-Length`,
      // so a resolver that read the body would enrol it: the 413 can only have
      // come from the header.
      const { res, body } = await refuse("huge-by-header");
      expect(res.status).toBe(413);
      expect(body).toMatchObject({ error: { code: "too_large" } });
    },
    TIMEOUT
  );

  it(
    "refuses a photograph that goes over MAX_OBJECT_BYTES while it is streaming",
    async () => {
      // No Content-Length at all, so only counting the stream can refuse it.
      const { res, body } = await refuse("huge-by-stream");
      expect(res.status).toBe(413);
      expect(body).toMatchObject({ error: { code: "too_large" } });
    },
    TIMEOUT
  );

  it(
    "refuses an https URL that redirects to http, and runs no model",
    async () => {
      // The schema checks the URL the caller typed. Every later hop is the
      // resolver's, and a redirect down to http would pull the photograph over
      // the wire in clear from wherever it pointed.
      const { res, body, ran } = await refuse("redirect-to-http");
      expect(res.status).toBe(422);
      // The message, not only the code: an http hop the resolver followed
      // would be refused with the same `source_unfetchable` a moment later,
      // by whatever answered it, and the two must not read alike.
      expect(body).toMatchObject({
        error: {
          code: "source_unfetchable",
          message: expect.stringContaining("which is not https"),
        },
      });
      expect(ran).toEqual([]);
    },
    TIMEOUT
  );
});
