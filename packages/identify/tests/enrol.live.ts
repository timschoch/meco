/**
 * The live acceptance for enrolment: one Person enrolled on the production
 * database and the private store from a real photograph, named again in a
 * second photograph of the same person, then erased.
 *
 * Nothing here is stubbed: `records` over `meco-records-eu`, the private Blob
 * store in `fra1`, a seeded Brand, and the deployed Enricher reached through
 * the Preview's probe door (`GATEWAY_PROBE=1`, `POST /probe/annotate` — #118).
 * What this file proves is what a Brand would get.
 *
 * The photograph is a fixture one, which `docs/specs/identify.md` and ADR-0003
 * Decision 2 say enrolment must not treat as a precedent. It is here because
 * meco has no consenting live subject yet; the Person is created and erased
 * inside one run, and replacing the photograph with a consenting subject's is
 * the only change this file then needs.
 *
 * Out of `pnpm check` by its file name (`*.live.ts`, `vitest.live.config.ts`),
 * because it costs credentials, money and a round trip to Frankfurt.
 *
 * ```
 * vercel env pull .env.local
 * MODELS_PROBE_URL=https://<preview>/probe pnpm test:identify:live
 * ```
 *
 * `VERCEL_OIDC_TOKEN` has to be out of both `.env.local` and the shell.
 * `@meco/store` prefers it over the store's own token, and the one
 * `vercel env pull` writes on a laptop is scoped to the Development
 * environment: against the production Private Store it answers "Access
 * denied", which reads as a bad token rather than as the wrong credential.
 * `.envrc` (`dotenv`) exports it too, so taking it out of the file alone is
 * not enough.
 *
 * The Person is erased in an `afterAll` that runs whether the checks passed or
 * not, and the last check is the Erasure's own listing of the prefix: a live
 * run that leaves a Face Print behind has failed even if every assertion above
 * it passed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ModelsClient, createModelsClient } from "@meco/models";
import {
  type Erasure,
  neonDatabase,
  peoplePrefix,
  records,
} from "@meco/records";
import { blobStore } from "@meco/store";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type Annotator, MATCH_THRESHOLD, identify } from "../index";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set: run \`vercel env pull .env.local\``);
  }
  return value;
};

/**
 * Where the deployed Enricher answers. Not in `.env.local`: it is a Preview
 * deployment's URL with `/probe` on it, which changes with every push, so the
 * caller names it and the run says which door it used.
 */
const probeUrl = process.env["MODELS_PROBE_URL"] ?? "";

const photograph = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(
      fileURLToPath(new URL(`../../../fixtures/faces/${name}`, import.meta.url))
    )
  );

/** The two photographs: one to enrol from, one to be recognised in. */
const ENROL_FROM = "astronaut-portrait.jpg";
const MATCH_IN = "astronaut-portrait-2.jpg";

/** One private store and one Records for the whole run, as the gateway holds. */
const store = blobStore();
/**
 * A seeded Brand, never a throwaway one: `brands` has no delete, so a Brand
 * this file invented would outlive the run it was invented for and production
 * would collect one row per live acceptance. The Person under it is erased,
 * which is the thing being proved.
 */
let brand = "";
let open: ReturnType<typeof records>;
let models: ModelsClient;
let annotate: Annotator;
let personId = "";

beforeAll(async () => {
  if (probeUrl === "") {
    throw new Error(
      "MODELS_PROBE_URL is not set: point it at a Preview deployment's /probe"
    );
  }
  open = records({
    database: neonDatabase(required("RECORDS_DATABASE_URL_UNPOOLED")),
    store,
  });
  models = createModelsClient({ baseUrl: probeUrl, timeoutMs: 120_000 });
  annotate = (bytes, options) => models.annotate(bytes, options);

  const [seeded] = await open.brands.list();
  if (seeded === undefined) {
    throw new Error("no Brand on this database: run `pnpm records:seed` first");
  }
  brand = seeded.id;
  const person = await open.people.create({ brand, name: "Live subject 176" });
  personId = person.id;
  console.log(`brand ${brand}, person ${personId}`);
  console.log(`annotating through ${probeUrl}`);
}, 120_000);

afterAll(async () => {
  // Runs whether the checks passed or not: a live run that leaves a Face Print
  // on production is worse than a live run that failed.
  if (personId !== "") await open.people.erase(brand, personId);
  await open.close();
}, 120_000);

it("enrols a Person from a photograph, live", async () => {
  const bytes = photograph(ENROL_FROM);
  const enrolled = await identify({ records: open, store, annotate }).enrol({
    brand,
    personId,
    bytes,
    contentType: "image/jpeg",
    consentAt: new Date(),
  });

  if (enrolled.status !== "enrolled") throw new Error("expected enrolled");
  console.log(
    `enrolled ${enrolled.photo.id} region ${enrolled.photo.regionId} at ${enrolled.photo.storeKey}`
  );
  expect(
    enrolled.photo.storeKey.startsWith(`${peoplePrefix(brand, personId)}/`)
  ).toBe(true);
  expect(enrolled.photo.facePrint.vector).toHaveLength(512);
  expect(await store.list(peoplePrefix(brand, personId))).toHaveLength(1);
}, 180_000);

it("names that Person in a second photograph of them, live", async () => {
  // No `hash` here: the Annotation of the second photograph is only read, and
  // the hash check exists to stop a wrong Annotation being *filed* under a
  // hash. `enrol` above passed one.
  const annotation = await models.annotate(photograph(MATCH_IN));
  const { matches, faces } = await identify({
    records: open,
    store,
    annotate,
  }).match({ annotation, brand });

  console.log(`second photograph: ${JSON.stringify(faces)}`);
  expect(matches).toHaveLength(1);
  expect(matches[0]?.personId).toBe(personId);
  expect(matches[0]?.brand).toBe(brand);
  const named = matches[0];
  expect(named?.by).toBe("face");
  const similarity = named?.by === "face" ? named.similarity : undefined;
  expect(similarity).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  console.log(`similarity ${similarity?.toFixed(4)}`);
}, 180_000);

it("erases the Person and leaves the prefix empty", async () => {
  const erasure: Erasure = await open.people.erase(brand, personId);
  console.log(`erasure ${JSON.stringify(erasure)}`);
  expect(erasure.erased).toBe(true);
  expect(erasure.remaining).toEqual([]);
  expect(await store.list(peoplePrefix(brand, personId))).toEqual([]);
  personId = "";
}, 180_000);
