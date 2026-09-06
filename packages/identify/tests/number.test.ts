/**
 * The number Match Rule, over the two kart Annotations recorded through the
 * shipped Catalogue (`fixtures/karts/annotations/`, `ppocr@1` reading the
 * digits and `dfine@1` drawing the karts).
 *
 * A recording and not a hand-built Annotation, because every question this
 * rule answers is a question about boxes a detector really drew: whether the
 * `24` sits on the kart a person would say it sits on, and which of the three
 * nested vehicle boxes over the `21` is the kart. A fixture somebody typed
 * would answer those questions by construction.
 *
 * The database is real `records` over PGlite, as everywhere else in this
 * suite. Nothing here loads a model: the numbers are already on the
 * Annotation, and the Brand's own list is a row.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Annotation } from "@meco/contracts";
import type { Database, Records } from "@meco/records";
import { pgliteDatabase } from "@meco/records/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Identify, identify } from "../index";
import { PGLITE_TIMEOUT_MS, harness, refusingAnnotator } from "./harness";

const ANNOTATIONS = fileURLToPath(
  new URL("../../../fixtures/karts/annotations/", import.meta.url)
);

/**
 * One recording, parsed by the contracts schema here as well as by the
 * recorder, so a fixture that stops being a legal Annotation fails in this
 * package rather than somewhere downstream.
 */
const recording = (name: string): Annotation =>
  Annotation.parse(
    JSON.parse(readFileSync(`${ANNOTATIONS}${name}.json`, "utf8"))
  );

const grid = recording("kart-grid-24");
const target = recording("kart-24-target");

let database: Database;
let open: Awaited<ReturnType<typeof harness>>;
let records: Records;

beforeAll(async () => {
  database = pgliteDatabase();
  open = await harness(database);
  records = open.records;
}, PGLITE_TIMEOUT_MS);

afterAll(async () => {
  await database.close();
});

const identifier = (): Identify =>
  identify({ records, store: open.store, annotate: refusingAnnotator });

/** A Brand of its own per check, with one Person carrying `numbers`. */
async function brandWith(
  id: string,
  numbers: readonly string[]
): Promise<string> {
  await records.brands.ensure({ id, name: id });
  const person = await records.people.create({
    brand: id,
    name: `#${numbers.join("/")}`,
    numbers,
  });
  return person.id;
}

describe("the number Match Rule on the recorded grid", () => {
  it("names the kart the number is painted on, not the number and not the biggest kart", async () => {
    const brand = "numbers-lead";
    const personId = await brandWith(brand, ["24"]);

    const { matches } = await identifier().match({ annotation: grid, brand });

    expect(matches).toEqual([
      {
        regionId: "vehicle-3",
        personId,
        brand,
        by: "number",
        numberRegionId: "number-2",
      },
    ]);

    // The two things the Match is deliberately not. `number-2` is the digits
    // themselves, which no Crop is of; `vehicle-5` is the row-wide detection
    // covering 0.5527 of the frame against `vehicle-3`'s 0.1275, and it is what
    // a rule seeded on the largest box would have answered.
    const named = matches[0]!.regionId;
    expect(named).not.toBe("number-2");
    expect(named).not.toBe("vehicle-5");
  });

  it("takes the tighter of three vehicle boxes that all contain the number whole", async () => {
    const brand = "numbers-nested";
    const personId = await brandWith(brand, ["21"]);

    const { matches } = await identifier().match({ annotation: grid, brand });

    // `21` sits wholly inside `vehicle-8` (0.0918 of the frame), `vehicle-6`
    // (0.2898) and `vehicle-5` (0.5527). Only the smallest is the #21 kart.
    expect(matches).toEqual([
      {
        regionId: "vehicle-8",
        personId,
        brand,
        by: "number",
        numberRegionId: "number-4",
      },
    ]);
  });

  it("says nothing about a number no vehicle box holds", async () => {
    const brand = "numbers-no-kart";
    await brandWith(brand, ["227"]);

    // The grid's `227` is read at 0.6345 and overlaps no `vehicle` Region at
    // all. There is no kart to frame, and the digits are not one.
    const { matches } = await identifier().match({ annotation: grid, brand });
    expect(matches).toEqual([]);
  });

  it("says nothing about a number nobody carries", async () => {
    const brand = "numbers-stranger";
    await brandWith(brand, ["99"]);

    const { matches } = await identifier().match({ annotation: grid, brand });
    expect(matches).toEqual([]);
  });

  it("names every carried number in one photograph, in Region id order", async () => {
    const brand = "numbers-two";
    await records.brands.ensure({ id: brand, name: brand });
    const ada = await records.people.create({
      brand,
      name: "Ada",
      numbers: ["24"],
    });
    const grace = await records.people.create({
      brand,
      name: "Grace",
      numbers: ["66"],
    });

    const { matches } = await identifier().match({ annotation: grid, brand });

    expect(matches).toEqual([
      {
        regionId: "vehicle-3",
        personId: ada.id,
        brand,
        by: "number",
        numberRegionId: "number-2",
      },
      {
        regionId: "vehicle-4",
        personId: grace.id,
        brand,
        by: "number",
        numberRegionId: "number-3",
      },
    ]);
  });

  it("is a fact of the Brand, so another Brand's list names nobody", async () => {
    const brand = "numbers-mine";
    const other = "numbers-theirs";
    await brandWith(brand, ["24"]);
    await records.brands.ensure({ id: other, name: other });

    const { matches } = await identifier().match({ annotation: grid, brand: other });
    expect(matches).toEqual([]);
  });

  it("leaves the Face Verdicts alone: a number is not a face", async () => {
    const brand = "numbers-faces";
    await brandWith(brand, ["24"]);

    const { faces } = await identifier().match({ annotation: grid, brand });

    // The grid holds one face Region and four number Regions. `faces` is one
    // per face Region and nothing else, whatever the numbers said.
    expect(faces.map((one) => one.regionId)).toEqual(["face-1"]);
  });
});

describe("the number Match Rule on the target photograph", () => {
  it("names the only kart, whose driver is in a helmet and has no face at all", async () => {
    const brand = "numbers-target";
    const personId = await brandWith(brand, ["24"]);

    const identification = await identifier().match({
      annotation: target,
      brand,
    });

    expect(identification.matches).toEqual([
      {
        regionId: "vehicle-1",
        personId,
        brand,
        by: "number",
        numberRegionId: "number-1",
      },
    ]);
    // The reason the rule exists: the face rule has nothing to say here.
    expect(identification.faces).toEqual([]);
  });
});
