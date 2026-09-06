/**
 * Enrolment: refused whole or done whole.
 *
 * Every check runs the real adapters — `records` over PGlite and `memoryStore`
 * — and fakes only the model (ADR-0012, Decision 5). The Annotator here is a
 * committed fixture Annotation stamped with the hash of the bytes the check
 * actually sends, so the hash `enrol` computes, the hash the Annotation
 * carries and the hash the store files the bytes under are one number and a
 * drift between them fails here.
 *
 * The refusals are the point of the file. A refused photograph has to leave
 * `store.list("people/<brand>/<personId>")` empty and no row anywhere, so
 * nearly every check below ends by proving an absence rather than a value.
 */
import { createHash } from "node:crypto";
import { Annotation } from "@meco/contracts";
import {
  type Database,
  type PersonWithPrints,
  type Records,
  peoplePrefix,
} from "@meco/records";
import { pgliteDatabase } from "@meco/records/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Annotator,
  type Enrolment,
  type Identify,
  IdentifyError,
  MIN_FACE_PX,
  PRINT_MODEL,
  identify,
} from "../index";
import { annotationOf, faceIn, kartAnnotationOf, printOf } from "./fixtures";
import { type Harness, PGLITE_TIMEOUT_MS, harness } from "./harness";

let database: Database;
let open: Harness;

beforeAll(async () => {
  database = pgliteDatabase();
  open = await harness(database);
}, PGLITE_TIMEOUT_MS);

afterAll(async () => {
  await database.close();
});

/** The one-face photograph, and the three-face one. */
const portrait = annotationOf("astronaut-portrait.jpg");
const soyuz = annotationOf("soyuz-crew.jpg");
/** Person A's face in the crew photograph, and two strangers'. */
const A_IN_CREW = faceIn(soyuz, "left");
const F_IN_CREW = faceIn(soyuz, "centre");
const G_IN_CREW = faceIn(soyuz, "right");
/** The photograph the Not-a-Face Print was taken from: the back of a helmet. */
const helmet = kartAnnotationOf("on-track-rear-helmet.jpg");

/** A Model that is not the Print Model. Any other `{ name, version }` will do. */
const ANOTHER_MODEL = { name: "edgeface", version: "2" } as const;

/**
 * One photograph as `enrol` is given it: bytes nobody has to invent, and an
 * Annotator that answers with `annotation` for exactly those bytes' hash and
 * refuses any other, the way the models client's own hash check does.
 *
 * `name` makes the bytes: two checks that send different names send different
 * bytes, so they file under different Store Keys and never dedupe onto each
 * other.
 */
interface Photograph {
  readonly bytes: Uint8Array;
  readonly hash: string;
  readonly annotation: Annotation;
  readonly annotate: Annotator;
  /** How many times the Annotator was called. */
  calls(): number;
}

const photograph = (annotation: Annotation, name: string): Photograph => {
  const bytes = new TextEncoder().encode(name);
  const hash = createHash("sha256").update(bytes).digest("hex");
  // Parsed, not spread and cast: the stamped hash has to still be a legal
  // Annotation, and the fixture builders are the only thing that made it one.
  const stamped = Annotation.parse({ ...annotation, hash });
  let calls = 0;
  return {
    bytes,
    hash,
    annotation: stamped,
    annotate: async (given, options) => {
      calls += 1;
      if (options.hash !== hash) {
        throw new Error(`the Annotator was asked for ${options.hash}`);
      }
      if (createHash("sha256").update(given).digest("hex") !== hash) {
        throw new Error("the Annotator was given other bytes than the hash");
      }
      return stamped;
    },
    calls: () => calls,
  };
};

/** identify over the harness's real records and store, and this photograph. */
const identifier = (photo: Photograph): Identify =>
  identify({
    records: open.records,
    store: open.store,
    annotate: photo.annotate,
  });

/** A Brand and a Person of it, both fresh, so no check sees another's rows. */
let brands = 0;
const someone = async (): Promise<{ brand: string; personId: string }> => {
  brands += 1;
  const brand = `b${brands}`;
  await open.records.brands.ensure({ id: brand, name: brand });
  const person = await open.records.people.create({ brand, name: "Subject" });
  return { brand, personId: person.id };
};

/** The Annotation with its Regions replaced, parsed again on the way out. */
const withRegions = (
  annotation: Annotation,
  regions: readonly unknown[]
): Annotation => Annotation.parse({ ...annotation, regions });

/** One Region of a fixture Annotation, edited. */
const edited = (
  annotation: Annotation,
  regionId: string,
  change: Record<string, unknown>
): unknown => {
  const region = annotation.regions.find((one) => one.id === regionId);
  if (region === undefined) throw new Error(`no region ${regionId}`);
  return { ...region, ...change };
};

/** Everything under this Person's prefix, which a refusal leaves empty. */
const stored = (brand: string, personId: string) =>
  open.store.list(peoplePrefix(brand, personId));

/** This Person as records holds them, with every Reference Photo row. */
const rowsOf = async (
  brand: string,
  personId: string
): Promise<PersonWithPrints> => {
  const found = await personIn(brand, personId);
  if (found === undefined) throw new Error(`no person ${personId}`);
  return found;
};

/** The same, but tolerant: a refusal check may name a Person that never was. */
const personIn = async (
  brand: string,
  personId: string
): Promise<PersonWithPrints | undefined> => {
  const people = await open.records.people.list(brand);
  return people.find((one) => one.id === personId);
};

/**
 * Runs an enrolment that must be refused, and proves the refusal left nothing:
 * the code asked for, no object under the prefix, no Reference Photo row, and
 * no Annotation filed under the photograph's hash.
 */
const refused = async (options: {
  readonly photo: Photograph;
  readonly brand: string;
  readonly personId: string;
  readonly code: string;
  readonly consentAt?: Date;
  readonly regionId?: string;
}): Promise<IdentifyError> => {
  const { photo, brand, personId } = options;
  const thrown = await identifier(photo)
    .enrol({
      brand,
      personId,
      bytes: photo.bytes,
      contentType: "image/jpeg",
      consentAt: options.consentAt as Date,
      ...(options.regionId === undefined ? {} : { regionId: options.regionId }),
    })
    .then(
      () => null,
      (error: unknown) => error
    );

  expect(thrown).toBeInstanceOf(IdentifyError);
  const error = thrown as IdentifyError;
  expect(error.code).toBe(options.code);
  expect(await stored(brand, personId)).toEqual([]);
  expect((await personIn(brand, personId))?.photos ?? []).toEqual([]);
  expect(await open.records.annotations.get(photo.hash)).toBeNull();
  expect(await open.records.files.get(photo.hash)).toBeNull();
  return error;
};

/**
 * Runs an enrolment that must be done, and hands back the Reference Photo it
 * filed. The mirror of {@link refused}: the same request shape, and the status
 * narrowed once here rather than in every check.
 */
const enrolled = async (options: {
  readonly photo: Photograph;
  readonly brand: string;
  readonly personId: string;
  readonly consentAt: Date;
  readonly regionId?: string;
}): Promise<Extract<Enrolment, { status: "enrolled" }>> => {
  const { photo, brand, personId, consentAt } = options;
  const outcome = await identifier(photo).enrol({
    brand,
    personId,
    bytes: photo.bytes,
    contentType: "image/jpeg",
    consentAt,
    ...(options.regionId === undefined ? {} : { regionId: options.regionId }),
  });
  if (outcome.status !== "enrolled") {
    throw new Error(`expected enrolled, got ${outcome.status}`);
  }
  return outcome;
};

describe("enrol, before the Annotator", () => {
  it("refuses a missing consent date and never calls the Annotator", async () => {
    const { brand, personId } = await someone();
    const photo = photograph(portrait.annotation, "no-consent");
    const error = await refused({
      photo,
      brand,
      personId,
      code: "consent_required",
      consentAt: undefined,
    });
    expect(error.message).toMatch(/consent/i);
    expect(photo.calls()).toBe(0);
  });

  it("refuses a consent date that is not a date", async () => {
    const { brand, personId } = await someone();
    const photo = photograph(portrait.annotation, "bad-consent");
    await refused({
      photo,
      brand,
      personId,
      code: "consent_required",
      consentAt: new Date("not a date"),
    });
    expect(photo.calls()).toBe(0);
  });

  it("refuses a Person this Brand has not created", async () => {
    const { brand } = await someone();
    const photo = photograph(portrait.annotation, "unknown-person");
    await refused({
      photo,
      brand,
      personId: "3f7a2b5c-0000-4000-8000-000000000000",
      code: "unknown_person",
      consentAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(photo.calls()).toBe(0);
  });

  it("refuses a Person of another Brand", async () => {
    const mine = await someone();
    const theirs = await someone();
    const photo = photograph(portrait.annotation, "other-brand");
    await refused({
      photo,
      brand: mine.brand,
      personId: theirs.personId,
      code: "unknown_person",
      consentAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  });
});

describe("enrol, choosing the face", () => {
  const consentAt = new Date("2026-02-03T04:05:06.000Z");

  it("refuses a photograph with no face in it", async () => {
    const { brand, personId } = await someone();
    const photo = photograph(withRegions(portrait.annotation, []), "no-face");
    const error = await refused({
      photo,
      brand,
      personId,
      code: "no_face",
      consentAt,
    });
    expect(error.message).toMatch(/face/i);
  });

  it("refuses a regionId that is not a face Region of this Annotation", async () => {
    const { brand, personId } = await someone();
    const photo = photograph(soyuz.annotation, "unknown-region");
    await refused({
      photo,
      brand,
      personId,
      code: "unknown_region",
      consentAt,
      regionId: "face-99",
    });
  });

  it("returns choose, largest first, and writes nothing", async () => {
    const { brand, personId } = await someone();
    const photo = photograph(soyuz.annotation, "choose");
    const outcome = await identifier(photo).enrol({
      brand,
      personId,
      bytes: photo.bytes,
      contentType: "image/jpeg",
      consentAt,
    });

    if (outcome.status !== "choose") throw new Error("expected choose");
    expect(outcome.faces.map((one) => one.regionId)).toEqual([
      A_IN_CREW.regionId,
      F_IN_CREW.regionId,
      G_IN_CREW.regionId,
    ]);
    const sizes = outcome.faces.map((one) => one.pixels);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(sizes.every((one) => one >= MIN_FACE_PX)).toBe(true);
    for (const face of outcome.faces) expect(face.box.width).toBeGreaterThan(0);

    expect(await stored(brand, personId)).toEqual([]);
    expect((await rowsOf(brand, personId)).photos).toEqual([]);
  });

  it("enrols the face the regionId names, not the largest", async () => {
    const { brand, personId } = await someone();
    const photo = photograph(soyuz.annotation, "named-region");
    const outcome = await enrolled({
      photo,
      brand,
      personId,
      consentAt,
      regionId: G_IN_CREW.regionId,
    });

    expect(outcome.photo.regionId).toBe(G_IN_CREW.regionId);
    expect(outcome.photo.facePrint.vector).toEqual(
      printOf("soyuz-crew.jpg", "right")
    );
  });

  it("enrols the only face when the photograph has one", async () => {
    const { brand, personId } = await someone();
    const photo = photograph(portrait.annotation, "one-face");
    const outcome = await enrolled({ photo, brand, personId, consentAt });
    expect(outcome.photo.regionId).toBe("face-1");
  });
});

describe("enrol, the Identifiable Face gate", () => {
  const consentAt = new Date("2026-02-03T04:05:06.000Z");

  it("refuses the back of a crash helmet and writes nothing", async () => {
    const { brand, personId } = await someone();
    const photo = photograph(helmet.annotation, "helmet");
    const error = await refused({
      photo,
      brand,
      personId,
      code: "not_a_face",
      consentAt,
    });
    expect(error.message).toMatch(/helmet/i);
  });

  it("refuses a face too small in the Decoded Image", async () => {
    const { brand, personId } = await someone();
    const region = portrait.annotation.regions[0];
    if (region === undefined) throw new Error("no region");
    const tiny = withRegions(portrait.annotation, [
      edited(portrait.annotation, region.id, {
        box: { ...region.box, width: 0.005, height: 0.005 },
      }),
    ]);
    const error = await refused({
      photo: photograph(tiny, "too-small"),
      brand,
      personId,
      code: "too_small",
      consentAt,
    });
    expect(error.message).toMatch(/closer/i);
  });

  it("refuses a face the Enricher could not print", async () => {
    const { brand, personId } = await someone();
    const region = portrait.annotation.regions[0];
    if (region === undefined) throw new Error("no region");
    const { facePrint: _dropped, ...unprinted } = region;
    const error = await refused({
      photo: photograph(
        withRegions(portrait.annotation, [unprinted]),
        "no-print"
      ),
      brand,
      personId,
      code: "no_print",
      consentAt,
    });
    expect(error.message).toMatch(/square on/i);
  });

  it("refuses a print from another Model", async () => {
    const { brand, personId } = await someone();
    const region = portrait.annotation.regions[0];
    if (region === undefined) throw new Error("no region");
    await refused({
      photo: photograph(
        withRegions(portrait.annotation, [
          edited(portrait.annotation, region.id, {
            facePrint: {
              model: ANOTHER_MODEL,
              vector: printOf("astronaut-portrait.jpg", "centre"),
            },
          }),
        ]),
        "other-model"
      ),
      brand,
      personId,
      code: "other_model",
      consentAt,
    });
  });
});

describe("enrol, what a done enrolment wrote", () => {
  const consentAt = new Date("2026-02-03T04:05:06.000Z");

  it("writes the bytes, the File, the Annotation and the row", async () => {
    const { brand, personId } = await someone();
    const photo = photograph(portrait.annotation, "written");
    const outcome = await enrolled({ photo, brand, personId, consentAt });

    const prefix = peoplePrefix(brand, personId);
    const objects = await stored(brand, personId);
    expect(objects.map((one) => one.key)).toEqual([
      `${prefix}/${photo.hash}.jpg`,
    ]);
    expect(await open.store.get(objects[0]?.key ?? "")).toEqual(photo.bytes);

    const file = await open.records.files.get(photo.hash);
    expect(file).toMatchObject({
      hash: photo.hash,
      mime: "image/jpeg",
      width: photo.annotation.width,
      height: photo.annotation.height,
      bytes: photo.bytes.byteLength,
    });

    expect(await open.records.annotations.get(photo.hash)).toEqual(
      photo.annotation
    );
    expect(outcome.annotation).toEqual(photo.annotation);

    const { photos } = await rowsOf(brand, personId);
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({
      personId,
      brand,
      hash: photo.hash,
      storeKey: `${prefix}/${photo.hash}.jpg`,
      regionId: "face-1",
      consentAt: consentAt.toISOString(),
    });
    expect(photos[0]?.facePrint.model).toEqual(PRINT_MODEL);
    expect(photos[0]?.facePrint.vector).toEqual(
      printOf("astronaut-portrait.jpg", "centre")
    );
    expect(outcome.photo).toEqual(photos[0]);
  });

  it("files the bytes under people/, never under sources/", async () => {
    const { brand, personId } = await someone();
    const photo = photograph(portrait.annotation, "under-people");
    await enrolled({ photo, brand, personId, consentAt });
    const { photos } = await rowsOf(brand, personId);
    expect(
      photos[0]?.storeKey.startsWith(`${peoplePrefix(brand, personId)}/`)
    ).toBe(true);
    expect(await open.store.list("sources")).toEqual([]);
  });

  it("removes the bytes again when the row cannot be written", async () => {
    const { brand, personId } = await someone();
    const photo = photograph(portrait.annotation, "row-refused");
    // The real `Records`, with one method made to fail. Not a fake `Records`
    // (ADR-0012, Decision 5): every other method is the PGlite adapter under
    // its own conformance suite, and the only way to see what a half-written
    // enrolment leaves behind is to half-write one.
    const refusing: Records = {
      ...open.records,
      people: {
        ...open.records.people,
        enrol: () => Promise.reject(new Error("the row was refused")),
      },
    };

    await expect(
      identify({
        records: refusing,
        store: open.store,
        annotate: photo.annotate,
      }).enrol({
        brand,
        personId,
        bytes: photo.bytes,
        contentType: "image/jpeg",
        consentAt,
      })
    ).rejects.toThrow("the row was refused");

    // The bytes are the part no later delete could reach: an Erasure walks the
    // rows, and this photograph never got one. The `files` row and the
    // Annotation that did land are the Sweep's, which reads rows.
    expect(await stored(brand, personId)).toEqual([]);
  });

  it("enrols, then names that Person in another photograph of them", async () => {
    const { brand, personId } = await someone();
    const photo = photograph(portrait.annotation, "enrol-then-match");
    await enrolled({ photo, brand, personId, consentAt });

    const { matches, faces } = await identifier(photo).match({
      annotation: soyuz.annotation,
      brand,
    });
    expect(matches.map((one) => one.regionId)).toEqual([A_IN_CREW.regionId]);
    expect(matches[0]?.personId).toBe(personId);
    expect(matches[0]?.brand).toBe(brand);
    expect(
      faces
        .filter((one) => one.verdict === "unknown")
        .map((one) => one.regionId)
    ).toEqual([F_IN_CREW.regionId, G_IN_CREW.regionId]);
  });
});
