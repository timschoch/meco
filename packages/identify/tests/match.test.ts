/**
 * The Match Rule, over the committed fixture prints.
 *
 * Every check runs the real adapters: `records` over PGlite and `memoryStore`,
 * both under their own conformance suites. Nothing here loads ONNX, reaches
 * the network, or fakes a `Records` (ADR-0012, Decision 5).
 *
 * One database serves the file and every check enrols under its own Brand id,
 * because a PGlite start costs about a second and the isolation a check needs
 * is `people.list(brand)`, which is the thing under test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Annotation, type Region } from "@meco/contracts";
import type { Database, Records } from "@meco/records";
import { pgliteDatabase } from "@meco/records/pglite";
import {
  type Identify,
  MATCH_MARGIN,
  MATCH_THRESHOLD,
  MIN_FACE_PX,
  PRINT_MODEL,
  identify,
} from "../index";
import {
  annotationOf,
  cosine,
  faceIn,
  kartAnnotationOf,
  kartPhotographs,
  kartPrint,
  kartPrints,
  kartRegionId,
  printOf,
} from "./fixtures";
import {
  type Harness,
  PGLITE_TIMEOUT_MS,
  harness,
  refusingAnnotator,
} from "./harness";

let database: Database;
let open: Harness;

beforeAll(async () => {
  database = pgliteDatabase();
  open = await harness(database);
}, PGLITE_TIMEOUT_MS);

afterAll(async () => {
  await database.close();
});

/** identify over the harness's real records and store, and no model. */
const identifier = (records: Records = open.records): Identify =>
  identify({ records, store: open.store, annotate: refusingAnnotator });

/** The photograph every check identifies: Person A between two strangers. */
const soyuz = annotationOf("soyuz-crew.jpg");
const A = faceIn(soyuz, "left");
const F = faceIn(soyuz, "centre");
const G = faceIn(soyuz, "right");

/** The three committed prints of the one fixture Person with more than one. */
const A_PORTRAIT = printOf("astronaut-portrait.jpg", "centre");
const A_PORTRAIT_2 = printOf("astronaut-portrait-2.jpg", "centre");
/** A stranger's print, and the nearest one to Person A in the fixture set. */
const C_GROUP = printOf("artemis-2-crew.jpg", "back centre");

/** A Model that is not the Print Model. Any other `{ name, version }` will do. */
const ANOTHER_MODEL = { name: "edgeface", version: "2" } as const;

/** The verdict on one face, by Region id, so a check names a face. */
const verdictOn = (
  faces: readonly { readonly regionId: string }[],
  regionId: string
) => {
  const found = faces.find((one) => one.regionId === regionId);
  if (found === undefined) throw new Error(`no verdict for ${regionId}`);
  return found;
};

/** The same Annotation with its Regions replaced, parsed again on the way out. */
const withRegions = (regions: readonly unknown[]): Annotation =>
  Annotation.parse({ ...soyuz.annotation, regions });

/** One fixture Region, edited. The result is parsed by {@link withRegions}. */
const edited = (regionId: string, change: Record<string, unknown>): unknown => {
  const region = soyuz.annotation.regions.find((one) => one.id === regionId);
  if (region === undefined) throw new Error(`no region ${regionId}`);
  return { ...region, ...change };
};

const without = (regionId: string, field: keyof Region): unknown => {
  const region = soyuz.annotation.regions.find((one) => one.id === regionId);
  if (region === undefined) throw new Error(`no region ${regionId}`);
  const { [field]: _dropped, ...rest } = region;
  return rest;
};

describe("identify().match", () => {
  it(
    "names nobody for a Brand that enrolled nobody, and reports no similarity",
    async () => {
      await open.records.brands.ensure({ id: "empty", name: "Empty" });

      const found = await identifier().match({
        annotation: soyuz.annotation,
        brand: "empty",
      });

      expect(found.matches).toEqual([]);
      expect(found.unusableReferencePhotos).toEqual([]);
      // No Person to compare against is not a similarity of zero: there was no
      // comparison, so there is no best and no runner-up.
      expect(found.faces).toEqual([
        { regionId: "face-1", verdict: "unknown" },
        { regionId: "face-2", verdict: "unknown" },
        { regionId: "face-3", verdict: "unknown" },
      ]);
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "names the held-out print of an enrolled Person and leaves every stranger unknown",
    async () => {
      const brand = "held-out";
      const person = await open.enrol({
        brand,
        name: "A",
        prints: [A_PORTRAIT, A_PORTRAIT_2],
      });

      const found = await identifier().match({
        annotation: soyuz.annotation,
        brand,
      });

      // Person A's third photograph, which was never enrolled.
      expect(verdictOn(found.faces, A.regionId)).toEqual({
        regionId: A.regionId,
        verdict: "match",
        personId: person.id,
        similarity: expect.closeTo(0.8228, 4),
      });
      expect(found.matches).toEqual([
        {
          regionId: A.regionId,
          personId: person.id,
          brand,
          similarity: expect.closeTo(0.8228, 4),
        },
      ]);

      // The two strangers in the same photograph, well under the threshold.
      for (const [face, best] of [
        [F, 0.0861],
        [G, 0.1003],
      ] as const) {
        const verdict = verdictOn(found.faces, face.regionId);
        expect(verdict).toEqual({
          regionId: face.regionId,
          verdict: "unknown",
          best: expect.closeTo(best, 4),
        });
        expect(best).toBeLessThan(MATCH_THRESHOLD);
      }
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "matches on the strongest Reference Photo, not on their mean",
    async () => {
      // Two Reference Photos: 0.8228 and 0.7263 against the held-out face.
      const twice = await open.enrol({
        brand: "best-of-two",
        name: "A",
        prints: [A_PORTRAIT, A_PORTRAIT_2],
      });
      const ofTwo = await identifier().match({
        annotation: soyuz.annotation,
        brand: "best-of-two",
      });
      expect(verdictOn(ofTwo.faces, A.regionId)).toMatchObject({
        verdict: "match",
        personId: twice.id,
        // The mean of the two is 0.7746. The threshold was calibrated on the
        // best (ADR-0012, Decision 3), so the best is what is reported.
        similarity: expect.closeTo(0.8228, 4),
      });

      // A third Reference Photo, a group photograph where the wrong face was
      // chosen at enrolment: 0.2979 against the same held-out face. Enrolling
      // more photographs must help and never hurt, so the answer must not move.
      const thrice = await open.enrol({
        brand: "best-of-three",
        name: "A",
        prints: [A_PORTRAIT, A_PORTRAIT_2, C_GROUP],
      });
      const ofThree = await identifier().match({
        annotation: soyuz.annotation,
        brand: "best-of-three",
      });
      expect(verdictOn(ofThree.faces, A.regionId)).toMatchObject({
        verdict: "match",
        personId: thrice.id,
        // The mean of the three is 0.6157, and it is not this number.
        similarity: expect.closeTo(0.8228, 4),
      });
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "refuses a face two People are within the margin of, and reports both numbers",
    async () => {
      // The same photograph enrolled for two People — a mistake at enrolment,
      // or twins. Both come out at 0.8228, a margin of exactly nothing.
      const brand = "a-tie";
      const first = await open.enrol({
        brand,
        name: "A",
        prints: [A_PORTRAIT],
      });
      const second = await open.enrol({
        brand,
        name: "A again",
        prints: [A_PORTRAIT],
      });

      const found = await identifier().match({
        annotation: soyuz.annotation,
        brand,
      });

      expect(verdictOn(found.faces, A.regionId)).toEqual({
        regionId: A.regionId,
        verdict: "unknown",
        best: expect.closeTo(0.8228, 4),
        runnerUp: expect.closeTo(0.8228, 4),
      });
      // Above the threshold and named after neither: the margin is the whole
      // difference between a Match and the wrong name on a published post.
      expect(0.8228).toBeGreaterThan(MATCH_THRESHOLD);
      expect(found.matches).toEqual([]);
      expect([first.id, second.id]).toHaveLength(2);
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "names the nearer of two People once they are more than the margin apart",
    async () => {
      const brand = "clear-of-the-margin";
      const nearer = await open.enrol({
        brand,
        name: "A",
        prints: [A_PORTRAIT],
      });
      await open.enrol({
        brand,
        name: "A once removed",
        prints: [A_PORTRAIT_2],
      });

      const found = await identifier().match({
        annotation: soyuz.annotation,
        brand,
      });

      expect(verdictOn(found.faces, A.regionId)).toEqual({
        regionId: A.regionId,
        verdict: "match",
        personId: nearer.id,
        similarity: expect.closeTo(0.8228, 4),
        runnerUp: expect.closeTo(0.7263, 4),
      });
      expect(0.8228 - 0.7263).toBeGreaterThan(MATCH_MARGIN);
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "never names a Person of another Brand",
    async () => {
      const mine = "brand-a";
      const theirs = "brand-b";
      await open.enrol({ brand: mine, name: "A", prints: [A_PORTRAIT] });
      await open.enrol({ brand: theirs, name: "C", prints: [C_GROUP] });

      const found = await identifier().match({
        annotation: soyuz.annotation,
        brand: theirs,
      });

      // Brand B sees only its own Person, whose best is 0.2979 — under the
      // threshold. Brand A's 0.8228 is not in the answer at any strength.
      expect(found.matches).toEqual([]);
      expect(verdictOn(found.faces, A.regionId)).toEqual({
        regionId: A.regionId,
        verdict: "unknown",
        best: expect.closeTo(0.2979, 4),
      });
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "reads the Brand's People once and calls no model",
    async () => {
      const brand = "one-read";
      await open.enrol({ brand, name: "A", prints: [A_PORTRAIT] });

      let reads = 0;
      const counted: Records = {
        ...open.records,
        people: {
          ...open.records.people,
          list: async (of) => {
            reads += 1;
            return open.records.people.list(of);
          },
        },
      };

      // `refusingAnnotator` throws when called, so a `match` that reached for a
      // model would fail here rather than pass quietly.
      await identifier(counted).match({
        annotation: soyuz.annotation,
        brand,
      });

      expect(reads).toBe(1);
    },
    PGLITE_TIMEOUT_MS
  );
});

describe("identify().match, the faces it will not compare", () => {
  it(
    "leaves a face with no Face Print uncompared, and out of the matches",
    async () => {
      const brand = "no-print";
      await open.enrol({ brand, name: "A", prints: [A_PORTRAIT] });

      const found = await identifier().match({
        annotation: withRegions([
          without(A.regionId, "facePrint"),
          edited(F.regionId, {}),
          edited(G.regionId, {}),
        ]),
        brand,
      });

      // Never compared is not the same answer as compared and unknown: one is
      // a gap in the question, the other an answer to it (`CONTEXT.md`).
      expect(verdictOn(found.faces, A.regionId)).toEqual({
        regionId: A.regionId,
        verdict: "uncompared",
        reason: "no-print",
      });
      expect(found.matches).toEqual([]);
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "leaves a face printed by another Model uncompared",
    async () => {
      const brand = "other-model";
      await open.enrol({ brand, name: "A", prints: [A_PORTRAIT] });

      const found = await identifier().match({
        annotation: withRegions([
          edited(A.regionId, {
            facePrint: {
              model: ANOTHER_MODEL,
              vector: A_PORTRAIT,
            },
          }),
        ]),
        brand,
      });

      expect(found.faces).toEqual([
        { regionId: A.regionId, verdict: "uncompared", reason: "other-model" },
      ]);
      expect(found.matches).toEqual([]);
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "reports a Reference Photo printed by another Model as unusable, and compares without it",
    async () => {
      const brand = "unusable";
      // Person A's strongest photograph, filed under a Model the Match Rule was
      // never calibrated on. Only the weaker one may lend a name.
      const stale = await open.enrol({
        brand,
        name: "A, before the swap",
        prints: [A_PORTRAIT],
        model: ANOTHER_MODEL,
      });
      await open.enrol({ brand, name: "A", prints: [A_PORTRAIT_2] });

      const found = await identifier().match({
        annotation: soyuz.annotation,
        brand,
      });

      const photos = await open.records.people.list(brand);
      const unusable = photos
        .filter((one) => one.id === stale.id)
        .flatMap((one) => one.photos.map((photo) => photo.id));
      expect(found.unusableReferencePhotos).toEqual(unusable);

      // 0.7263, the weaker photograph, and never 0.8228.
      expect(verdictOn(found.faces, A.regionId)).toMatchObject({
        verdict: "match",
        similarity: expect.closeTo(0.7263, 4),
      });
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "will not compare a print of the wrong length, however it is labelled",
    async () => {
      const brand = "wrong-length";
      // A Person enrolled from a print that names the Print Model and has four
      // floats. Scored term by term against a 512-float face it would read as
      // a similarity of 1 and name a stranger; it is unusable instead.
      const short = await open.enrol({
        brand,
        name: "Four floats",
        prints: [[0.5, 0.5, 0.5, 0.5]],
      });
      await open.enrol({ brand, name: "A", prints: [A_PORTRAIT] });

      const found = await identifier().match({
        annotation: soyuz.annotation,
        brand,
      });

      const listed = await open.records.people.list(brand);
      expect(found.unusableReferencePhotos).toEqual(
        listed
          .filter((one) => one.id === short.id)
          .flatMap((one) => one.photos.map((photo) => photo.id))
      );
      expect(verdictOn(found.faces, A.regionId)).toMatchObject({
        verdict: "match",
        similarity: expect.closeTo(0.8228, 4),
      });

      // The same rule on the way in: a face whose print is the wrong length
      // was not printed by this Model whatever its `{ name, version }` says.
      const mislabelled = await identifier().match({
        annotation: withRegions([
          edited(A.regionId, {
            facePrint: { model: PRINT_MODEL, vector: [0.5, 0.5, 0.5, 0.5] },
          }),
        ]),
        brand,
      });
      expect(mislabelled.faces).toEqual([
        { regionId: A.regionId, verdict: "uncompared", reason: "other-model" },
      ]);
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "judges the size floor in the Decoded Image and not in the photograph",
    async () => {
      const brand = "too-small";
      await open.enrol({ brand, name: "A", prints: [A_PORTRAIT] });

      // 8000 px on the long edge, so the Decode Bound shrinks the photograph to
      // a fifth before any model sees it. The smaller face is 80 px in the
      // photograph and 16 in the Decoded Image; the larger is 240 and 48.
      const print = {
        model: PRINT_MODEL,
        vector: A_PORTRAIT,
      };
      const landmarks = {
        rEye: { x: 0.11, y: 0.11 },
        lEye: { x: 0.13, y: 0.11 },
        nose: { x: 0.12, y: 0.12 },
        rMouth: { x: 0.11, y: 0.13 },
        lMouth: { x: 0.13, y: 0.13 },
      };
      const enormous = Annotation.parse({
        ...soyuz.annotation,
        width: 8000,
        height: 8000,
        regions: [
          {
            id: "face-1",
            kind: "face",
            label: "face",
            box: { x: 0.1, y: 0.1, width: 0.01, height: 0.01 },
            score: 0.9,
            model: { name: "yunet", version: "1" },
            landmarks,
            facePrint: print,
          },
          {
            id: "face-2",
            kind: "face",
            label: "face",
            box: { x: 0.3, y: 0.3, width: 0.03, height: 0.03 },
            score: 0.9,
            model: { name: "yunet", version: "1" },
            landmarks,
            facePrint: print,
          },
        ],
      });

      const found = await identifier().match({ annotation: enormous, brand });

      expect(verdictOn(found.faces, "face-1")).toMatchObject({
        verdict: "not-identifiable",
        reason: "too-small",
      });
      expect(verdictOn(found.faces, "face-2")).toMatchObject({
        verdict: "match",
      });
      // Both faces clear 40 px in the photograph; only one clears it decoded.
      expect(0.01 * 8000).toBeGreaterThan(MIN_FACE_PX);
      expect(found.matches).toHaveLength(1);
    },
    PGLITE_TIMEOUT_MS
  );
});

describe("identify().match, the things that are not faces", () => {
  /** The back of a crash helmet: the one print identify commits (ADR-0003). */
  const HELMET = kartPrint("on-track-rear-helmet.jpg#0");
  /**
   * A real face that scores 0.5091 against the helmet — over the Match
   * Threshold. It is why the gate runs on the enrolled prints as well as on
   * the detection: no check on this face can catch it, because it is a face.
   */
  const REAL_FACE_NEAR_THE_HELMET = kartPrint("paddock-mixed.jpg#4");

  it(
    "refuses to identify the detection the Not-a-Face Print was taken from, and names it",
    async () => {
      const brand = "a-helmet";
      await open.enrol({ brand, name: "A", prints: [A_PORTRAIT] });

      // The photograph the reference print came from, annotated whole. It is
      // 41 px in the Decoded Image, so it clears the size floor and the
      // Not-a-Face check is the only thing that can refuse it.
      const helmetPhoto = kartAnnotationOf("on-track-rear-helmet.jpg");
      const regionId = kartRegionId(helmetPhoto, "on-track-rear-helmet.jpg#0");

      const found = await identifier().match({
        annotation: helmetPhoto.annotation,
        brand,
      });

      expect(verdictOn(found.faces, regionId)).toMatchObject({
        verdict: "not-identifiable",
        reason: "not-a-face",
        // The detail names the reference and what a human saw in it, so a
        // Brand can be told why the refusal happened.
        detail: expect.stringContaining("on-track-rear-helmet.jpg#0"),
      });
      expect(found.matches).toEqual([]);
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "refuses a helmet it has never seen, out of the reference set",
    async () => {
      const brand = "another-helmet";
      await open.enrol({ brand, name: "A", prints: [A_PORTRAIT] });

      // A different driver, a different helmet, deliberately held out of the
      // reference set so its rejection is measured and not assumed.
      const heldOut = kartAnnotationOf("on-track-visor-open.jpg");
      const found = await identifier().match({
        annotation: heldOut.annotation,
        brand,
      });

      expect(
        verdictOn(
          found.faces,
          kartRegionId(heldOut, "on-track-visor-open.jpg#0")
        )
      ).toMatchObject({ verdict: "not-identifiable", reason: "not-a-face" });
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "reports a Person enrolled from a helmet as unusable, and lends their name to nobody",
    async () => {
      const brand = "enrolled-a-helmet";
      // Exactly issue #34: a Person enrolled from the back of a crash helmet,
      // before any Not-a-Face Print existed to refuse the photograph.
      const helmeted = await open.enrol({
        brand,
        name: "Enrolled from a helmet",
        prints: [HELMET.vector],
      });

      // A real face, 0.5091 against that print — over the Match Threshold and
      // the wrong person's name on a published photograph.
      const paddock = kartAnnotationOf("paddock-mixed.jpg");
      const regionId = kartRegionId(paddock, "paddock-mixed.jpg#4");

      const found = await identifier().match({
        annotation: paddock.annotation,
        brand,
      });

      const listed = await open.records.people.list(brand);
      expect(found.unusableReferencePhotos).toEqual(
        listed
          .filter((one) => one.id === helmeted.id)
          .flatMap((one) => one.photos.map((photo) => photo.id))
      );
      expect(found.matches).toEqual([]);
      // Compared against nobody usable, so there is no best at all — and in
      // particular not the 0.5091 that would have named them.
      expect(verdictOn(found.faces, regionId)).toEqual({
        regionId,
        verdict: "unknown",
      });
      expect(
        cosine(REAL_FACE_NEAR_THE_HELMET.vector, HELMET.vector)
      ).toBeGreaterThan(MATCH_THRESHOLD);
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "still compares the real faces of the same photograph",
    async () => {
      const brand = "a-paddock";
      // The paddock's own biggest face, enrolled: it must still be named in
      // the photograph it came from. The Not-a-Face rule refuses detections,
      // not photographs.
      const pointing = kartPrint("paddock-mixed.jpg#0");
      const person = await open.enrol({
        brand,
        name: "The man pointing",
        prints: [pointing.vector],
      });

      const paddock = kartAnnotationOf("paddock-mixed.jpg");
      const found = await identifier().match({
        annotation: paddock.annotation,
        brand,
      });

      expect(found.matches).toEqual([
        {
          regionId: kartRegionId(paddock, "paddock-mixed.jpg#0"),
          personId: person.id,
          brand,
          similarity: expect.closeTo(1, 4),
        },
      ]);
      // The man seen from behind, 0.6365 to the reference print, is refused.
      expect(
        verdictOn(found.faces, kartRegionId(paddock, "paddock-mixed.jpg#7"))
      ).toMatchObject({ verdict: "not-identifiable", reason: "not-a-face" });
      // The detection the aligner could not cut a square from carries no
      // print at all, and is uncompared rather than not-identifiable.
      expect(
        verdictOn(found.faces, kartRegionId(paddock, "paddock-mixed.jpg#1"))
      ).toEqual({
        regionId: kartRegionId(paddock, "paddock-mixed.jpg#1"),
        verdict: "uncompared",
        reason: "no-print",
      });
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "refuses exactly the kart detections ADR-0003 names, through the seam",
    async () => {
      const brand = "the-whole-sweep";
      await open.enrol({ brand, name: "A", prints: [A_PORTRAIT] });

      // The Not-a-Face sweep run as `match` and not as arithmetic beside it.
      // `tests/calibration.test.ts` recomputes the cosines; this says the rule
      // on the seam acts on them, over every kart photograph at once.
      const refused: string[] = [];
      const compared: string[] = [];
      for (const file of kartPhotographs()) {
        const photograph = kartAnnotationOf(file);
        const found = await identifier().match({
          annotation: photograph.annotation,
          brand,
        });
        for (const face of found.faces) {
          const detection = photograph.faces.find(
            (one) => one.regionId === face.regionId
          );
          if (detection?.is === undefined) continue;
          if (
            face.verdict === "not-identifiable" &&
            face.reason === "not-a-face"
          ) {
            refused.push(detection.id);
          } else {
            compared.push(detection.id);
          }
        }
      }

      expect(refused.sort()).toEqual([
        // The reference print itself, at a similarity of 1 to itself.
        "on-track-rear-helmet.jpg#0",
        // A second driver's helmet, held out of the reference set.
        "on-track-visor-open.jpg#0",
        // A man seen from behind: the rejection the rule exists for.
        "paddock-mixed.jpg#7",
        // A small child looking down, 40 px: the price, and the only real
        // face 0.60 refuses.
        "paddock-mixed.jpg#8",
      ]);
      // Every non-face in the fixture set is refused, and only one face is.
      const stillFaces = compared.map((id) => kartPrint(id).is);
      expect(stillFaces).not.toContain("not-a-face");
      expect(compared).toHaveLength(
        kartPrints().filter((one) => one.is === "face").length - 1
      );
    },
    PGLITE_TIMEOUT_MS
  );

  it(
    "asks about the size before it asks whether it is a face",
    async () => {
      const brand = "small-helmet";
      await open.enrol({ brand, name: "A", prints: [A_PORTRAIT] });

      // The helmet print on a face too small to have been printed at all.
      // Both refusals apply; the size is the one the spec asks first, because
      // it says what the Brand can do about it.
      const tiny = Annotation.parse({
        ...soyuz.annotation,
        width: 8000,
        height: 8000,
        regions: [
          {
            id: "face-1",
            kind: "face",
            label: "face",
            box: { x: 0.1, y: 0.1, width: 0.01, height: 0.01 },
            score: 0.9,
            model: { name: "yunet", version: "1" },
            landmarks: {
              rEye: { x: 0.11, y: 0.11 },
              lEye: { x: 0.13, y: 0.11 },
              nose: { x: 0.12, y: 0.12 },
              rMouth: { x: 0.11, y: 0.13 },
              lMouth: { x: 0.13, y: 0.13 },
            },
            facePrint: { model: PRINT_MODEL, vector: HELMET.vector },
          },
        ],
      });

      const found = await identifier().match({ annotation: tiny, brand });

      expect(verdictOn(found.faces, "face-1")).toMatchObject({
        verdict: "not-identifiable",
        reason: "too-small",
      });
    },
    PGLITE_TIMEOUT_MS
  );
});

describe("identify().match, the order of the answer", () => {
  it(
    "sorts matches and faces by Region id number, never by string and never by position",
    async () => {
      const brand = "eleven-faces";
      // One print, and every face carrying it, so the check is about the order
      // of the answer and about nothing else.
      const vector = A_PORTRAIT;
      await open.enrol({ brand, name: "Everyone", prints: [vector] });

      const regions = Array.from({ length: 11 }, (_unused, index) => ({
        id: `face-${index + 1}`,
        kind: "face",
        label: "face",
        box: {
          x: 0.02 + index * 0.08,
          y: 0.2,
          width: 0.06,
          height: 0.06,
        },
        score: 0.9,
        model: { name: "yunet", version: "1" },
        landmarks: {
          rEye: { x: 0.03 + index * 0.08, y: 0.21 },
          lEye: { x: 0.06 + index * 0.08, y: 0.21 },
          nose: { x: 0.045 + index * 0.08, y: 0.23 },
          rMouth: { x: 0.035 + index * 0.08, y: 0.25 },
          lMouth: { x: 0.055 + index * 0.08, y: 0.25 },
        },
        facePrint: { model: PRINT_MODEL, vector },
      }));

      const shuffled = Annotation.parse({
        ...soyuz.annotation,
        width: 1600,
        height: 1600,
        // Reversed, so an answer in the order the Regions arrived is visibly
        // the wrong one.
        regions: [...regions].reverse(),
      });

      const found = await identifier().match({
        annotation: shuffled,
        brand,
      });

      const inOrder = regions.map((one) => one.id);
      expect(found.faces.map((one) => one.regionId)).toEqual(inOrder);
      expect(found.matches.map((one) => one.regionId)).toEqual(inOrder);
      // `face-10` sorts before `face-2` as a string and after it as a number.
      expect(inOrder.indexOf("face-2")).toBeLessThan(
        inOrder.indexOf("face-10")
      );
    },
    PGLITE_TIMEOUT_MS
  );
});
