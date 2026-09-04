/**
 * People — the individuals a Brand wants meco to recognise.
 *
 * A Person is a record, not a stored output: it is addressed by a key meco
 * chose, it is overwritten in place, and it can be deleted. Everything about one
 * lives under a single prefix, `people/<brand>/<personId>/`, and that is not a
 * tidy-filing decision — it is what makes deletion a property rather than a
 * promise. Removing a Person is removing that prefix, so there is nowhere for a
 * Reference Photo or a Face Print to survive.
 *
 * The prefix is `PRIVATE_PREFIX` from `./storage.js`, which routes every key
 * under it to the private Blob store and keeps it out of the Gallery. A
 * Reference Photo is a face photograph of a named individual; it must not be
 * readable from its URL alone, so no URL for one ever leaves this module. The
 * bytes are served by meco itself, to a caller that carried the token.
 *
 * Nothing here talks to a transport. `app.ts` and `mcp.ts` are both shells over
 * these functions, so enrolling a Person over HTTP and over MCP is the same
 * code, refusing the same photographs for the same reasons.
 */
import { createHash, randomUUID } from "node:crypto";

import sharp from "sharp";
import { z } from "zod";

import { BRANDS } from "./brands.js";
import { detectFaces, embedFaces, type DetectedFace, type FaceBox } from "./faces.js";
import { PRIVATE_PREFIX, type Storage } from "./storage.js";

/**
 * How small a face may be and still be worth enrolling, in pixels of the Source
 * Image.
 *
 * EdgeFace is trained on 112×112 crops. A face smaller than this is upsampled
 * into the network, and what comes back is a Face Print of the interpolation
 * rather than of the person — it compares cleanly against everything and
 * identifies nobody. Refusing is the honest answer; the fix is a better
 * photograph, and only the caller has one.
 */
export const MIN_FACE_PX = 40;

/** What one Reference Photo is, as a caller sees it. */
export interface ReferencePhoto {
  /** The first 32 hex of the SHA-256 of the photograph. Its name under a Person. */
  photoId: string;
  /** The enrolled face, in fractions of the photograph, so the console can outline it. */
  face: FaceBox;
  /**
   * The format the bytes are stored in — `jpg`, `png` or `webp`.
   *
   * Kept on the record because it is the last segment of the key. Without it,
   * reading one Reference Photo would mean asking the store for each format in
   * turn, which on Blob is three network calls to find one object.
   */
  format: string;
  /** ISO 8601. */
  enrolledAt: string;
  /**
   * ISO 8601, when the enroller stated that this Person agreed to be enrolled.
   * Absent when nobody said so — which is a fact worth being able to read back,
   * not a default worth inventing.
   */
  consentAt?: string;
}

export interface Person {
  id: string;
  brand: string;
  name: string;
  /** ISO 8601. */
  createdAt: string;
  photos: ReferencePhoto[];
}

/** The stored Face Print of one enrolled face. */
export interface StoredFacePrint {
  personId: string;
  photoId: string;
  /** 512 floats on the unit sphere. */
  print: number[];
  printedAt: string;
}

// ------------------------------------------------------------------- the keys

/** Everything about one Person lives under this prefix, and nowhere else. */
export function personPrefix(brand: string, personId: string): string {
  return `${PRIVATE_PREFIX}/${brand}/${personId}`;
}

function personKey(brand: string, personId: string): string {
  return `${personPrefix(brand, personId)}/person.json`;
}

function photoKey(brand: string, personId: string, photoId: string, extension: string): string {
  return `${personPrefix(brand, personId)}/${photoId}.${extension}`;
}

function printKey(brand: string, personId: string, photoId: string): string {
  return `${personPrefix(brand, personId)}/${photoId}.print.json`;
}

/**
 * The formats a Reference Photo is stored in.
 *
 * An allowlist rather than whatever sharp decoded, because the extension is part
 * of the key and the content type is what meco later serves the bytes as. A
 * photograph in any other format is re-encoded to JPEG rather than refused: the
 * caller's file is not the artefact here, the face in it is.
 */
const STORABLE = [
  { format: "jpeg", extension: "jpg", contentType: "image/jpeg" },
  { format: "png", extension: "png", contentType: "image/png" },
  { format: "webp", extension: "webp", contentType: "image/webp" },
] as const;

/** How to serve one of the stored formats back. */
function contentTypeFor(extension: string): string {
  return STORABLE.find((f) => f.extension === extension)?.contentType ?? "application/octet-stream";
}

// -------------------------------------------------------------------- reading

/**
 * The Brand a Person belongs to, refusing one that does not exist.
 *
 * Checked before any key is built: `people/<brand>/…` with a brand nobody
 * defined would file a record where nothing will ever look for it again.
 */
function requireBrand(brand: string): string {
  if (!BRANDS.has(brand)) throw new Error(`No such brand: "${brand}"`);
  return brand;
}

async function readPerson(
  brand: string,
  personId: string,
  storage: Storage,
): Promise<Person | null> {
  const stored = await storage.get(personKey(brand, personId));
  if (!stored) return null;
  return JSON.parse(stored.toString("utf8")) as Person;
}

/** The Person, or a refusal naming the one that was asked for. */
export async function getPerson(
  brand: string,
  personId: string,
  storage: Storage,
): Promise<Person> {
  const person = await readPerson(requireBrand(brand), personId, storage);
  if (!person) throw new Error(`No such Person in "${brand}": "${personId}"`);
  return person;
}

async function writePerson(person: Person, storage: Storage): Promise<void> {
  await storage.putAt(
    personKey(person.brand, person.id),
    Buffer.from(JSON.stringify(person)),
    "application/json",
  );
}

/**
 * Every Person of one Brand, by name.
 *
 * Read from the store rather than from an index: one listing of the Brand's
 * prefix names every `person.json` there is, so a record that was written can
 * never be missing from the list and a record that was deleted can never linger
 * in it.
 */
export async function listPeople(brand: string, storage: Storage): Promise<Person[]> {
  const listings = await storage.list(`${PRIVATE_PREFIX}/${requireBrand(brand)}`);
  const people: Person[] = [];
  for (const item of listings) {
    if (!item.key.endsWith("/person.json")) continue;
    const stored = await storage.get(item.key);
    if (stored) people.push(JSON.parse(stored.toString("utf8")) as Person);
  }
  return people.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every Face Print a Brand has enrolled, with the Person each belongs to.
 *
 * The one place that answers "who does this Brand know". #14 turns it into a
 * nearest-neighbour search with a threshold and a runner-up margin; it stays one
 * function so that becomes an edit here rather than a second way of reaching the
 * same records.
 */
export interface EnrolledPrint extends StoredFacePrint {
  personName: string;
}

export async function facePrintsFor(
  brand: string,
  storage: Storage,
): Promise<EnrolledPrint[]> {
  const people = await listPeople(brand, storage);
  const prints: EnrolledPrint[] = [];
  for (const person of people) {
    for (const photo of person.photos) {
      const stored = await storage.get(printKey(brand, person.id, photo.photoId));
      // A photo whose print is missing is a half-written enrolment, not a face
      // that matches nothing. Skipped rather than counted as an empty Face Print.
      if (!stored) continue;
      const record = JSON.parse(stored.toString("utf8")) as StoredFacePrint;
      prints.push({ ...record, personName: person.name });
    }
  }
  return prints;
}

/**
 * The Reference Photo the record names, or a refusal.
 *
 * Every key for a photograph is built from a photoId the caller passed in, so
 * this is what stands between that and a key the Person does not own.
 */
function requirePhoto(person: Person, photoId: string): ReferencePhoto {
  const photo = person.photos.find((p) => p.photoId === photoId);
  if (!photo) {
    throw new Error(`No such Reference Photo for "${person.name}": "${photoId}"`);
  }
  return photo;
}

/** The bytes of one Reference Photo, with the type to serve them as. */
export async function referencePhotoBytes(
  brand: string,
  personId: string,
  photoId: string,
  storage: Storage,
): Promise<{ bytes: Buffer; contentType: string }> {
  const person = await getPerson(brand, personId, storage);
  const photo = requirePhoto(person, photoId);
  const bytes = await storage.get(photoKey(brand, personId, photoId, photo.format));
  if (!bytes) {
    throw new Error(`The Reference Photo "${photoId}" is on the record but not in the store.`);
  }
  return { bytes, contentType: contentTypeFor(photo.format) };
}

// ------------------------------------------------------------------- matching

/**
 * How alike two Face Prints are, from -1 to 1.
 *
 * Both are unit length — meco-faces normalises before it answers, and
 * `PRINT_LENGTH` is asserted at that boundary — so this is the dot product and
 * nothing else. No re-normalising here: a print that is not unit length is a
 * fault upstream, and quietly rescaling it would hide the fault behind a
 * plausible number.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Cannot compare Face Prints of length ${String(a.length)} and ${String(b.length)}.`,
    );
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * How alike a face must be to an enrolled one before meco will put a name on it.
 *
 * Calibrated on the committed fixture set in `fixtures/faces/`, not on
 * photographs of anyone meco has enrolled — nobody is enrolled yet. Over that
 * set the same person scores 0.73 at worst and two different people 0.29 at
 * best, so every value between the two makes the same decisions; 0.50 is the
 * middle of that interval, which is the point furthest from both mistakes.
 * `pnpm test:match` re-measures it, and
 * `docs/adr/0003-face-recognition-licence-consent-and-threshold.md` records
 * where the number came from and when it has to be earned again.
 */
export const MATCH_THRESHOLD = 0.5;

/**
 * How far the best Person must beat the second-best before the answer is a name.
 *
 * The threshold answers "is this anyone?"; the margin answers "is this *this*
 * one?". Two Persons of one Brand who look alike would otherwise be decided by
 * the third decimal of a cosine, and the loser's face would be blurred while the
 * winner's was published — a mistake with a person on the other end of it.
 *
 * Unlike the threshold this number is not measured, because the fixture set
 * holds no pair of people who look alike and an honest calibration cannot be
 * invented from a set that does not contain the case. It is a guard at the size
 * of the run-to-run noise, and re-earning it needs real enrolled People. Said
 * plainly in the ADR rather than implied by a decimal place.
 */
export const MATCH_MARGIN = 0.05;

/** A detected face meco is willing to put a name on. See CONTEXT.md. */
export interface Match {
  personId: string;
  /** The Person's name, so a caller never has to look one up to show a Match. */
  name: string;
  /** Cosine similarity against that Person's closest Face Print. */
  score: number;
}

/**
 * Which Person a face belongs to, or null — the open-set answer.
 *
 * "Nobody" is a valid and common result, so this is not a nearest-neighbour
 * lookup with the winner returned. Two things have to hold: the best Person
 * clears `MATCH_THRESHOLD` outright, and beats the runner-up by `MATCH_MARGIN`.
 * A face that fails either is unknown, which is the answer that keeps a stranger
 * out of a published post.
 *
 * The runner-up is the best *other Person*, never the second-best Face Print. A
 * Person with four Reference Photos would otherwise be their own runner-up and
 * could never clear the margin — the more meco knew about someone, the less it
 * could recognise them.
 *
 * `persons` narrows the answer, and it narrows it at the end rather than at the
 * start. Comparing against the Brand's whole gallery and then refusing a winner
 * nobody asked for is strictly safer than comparing against a subset: a face
 * that really belongs to an unlisted Person is caught by the margin instead of
 * being handed to whichever listed Person happened to score highest.
 */
export function matchFacePrint(
  print: readonly number[],
  enrolled: readonly EnrolledPrint[],
  persons?: readonly string[],
): Match | null {
  // The best score per Person, so that several Reference Photos of one Person
  // count once and cannot become each other's runner-up.
  const best = new Map<string, { name: string; score: number }>();
  for (const record of enrolled) {
    const score = cosineSimilarity(print, record.print);
    const current = best.get(record.personId);
    if (!current || score > current.score) {
      best.set(record.personId, { name: record.personName, score });
    }
  }

  const ranked = [...best.entries()].sort((a, b) => b[1].score - a[1].score);
  const [winner, second] = ranked;
  if (!winner) return null;

  const [personId, { name, score }] = winner;
  const runnerUp = second ? second[1].score : null;

  if (score < MATCH_THRESHOLD) return null;
  if (runnerUp !== null && score - runnerUp < MATCH_MARGIN) return null;
  // Asked for named Persons and the face is somebody else: not this caller's
  // Match, and not silently the runner-up's either.
  if (persons && !persons.includes(personId)) return null;

  return { personId, name, score };
}

export interface MatchInput {
  brand: string;
  /** The Source Image the faces were found in. `/embed` needs the pixels again. */
  source: Buffer;
  faces: readonly DetectedFace[];
  /** Limit the answer to these Person ids. */
  persons?: readonly string[];
}

export interface FaceMatches {
  /** One entry per face, in the order they were given. `null` is "unknown". */
  matches: (Match | null)[];
  /** Empty unless something a caller should hear about went wrong. */
  warnings: string[];
}

/**
 * Every face in one Source Image, named where meco can name it.
 *
 * Scoped to one Brand and no further: the Face Prints come from
 * `facePrintsFor`, which lists that Brand's prefix, so a Person of another Brand
 * is not compared against and not merely filtered out afterwards. Data isolation
 * between Brands is a property of which keys were read, which is the only place
 * it can be a property rather than a promise.
 *
 * Embedding is skipped entirely when the Brand has enrolled nobody. Sending the
 * photograph to `/embed` to compare against an empty gallery would be a network
 * call whose answer is known, and this is the common case — most Brands have no
 * People.
 *
 * A face service that fails yields no Matches and a warning rather than an
 * error. A Crop still has to come out: framing on the largest face and blurring
 * every face is the honest degradation, and it is what happens when meco cannot
 * tell one face from another. Enrolment does not share this leniency — see
 * `enrolReferencePhoto`, where there is nothing else to fall back to.
 */
export async function matchFaces(input: MatchInput, storage: Storage): Promise<FaceMatches> {
  const brand = requireBrand(input.brand);
  const none = { matches: input.faces.map(() => null), warnings: [] };
  if (input.faces.length === 0) return { matches: [], warnings: [] };

  const enrolled = await facePrintsFor(brand, storage);
  if (input.persons) {
    const known = new Set(enrolled.map((e) => e.personId));
    const unknown = input.persons.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `No enrolled Person in "${brand}" with id ${unknown.map((id) => `"${id}"`).join(", ")}. ` +
          "Only a Person of this Brand with at least one Reference Photo can be matched.",
      );
    }
  }
  if (enrolled.length === 0) return none;

  let prints: number[][];
  try {
    prints = await embedFaces(
      input.source,
      input.faces.map((face) => ({ landmarks: face.landmarks })),
    );
  } catch (err) {
    return { ...none, warnings: [`No faces were named: ${(err as Error).message}`] };
  }

  return {
    matches: prints.map((print) => matchFacePrint(print, enrolled, input.persons)),
    warnings: [],
  };
}

// ------------------------------------------------------------------- creating

export const addPersonBody = z.object({
  brand: z.string(),
  name: z.string().trim().min(1).max(120),
});

export type AddPersonInput = z.infer<typeof addPersonBody>;

export async function createPerson(
  input: AddPersonInput,
  storage: Storage,
): Promise<Person> {
  const person: Person = {
    id: randomUUID(),
    brand: requireBrand(input.brand),
    name: input.name.trim(),
    createdAt: new Date().toISOString(),
    photos: [],
  };
  await writePerson(person, storage);
  return person;
}

// ------------------------------------------------------------------ enrolling

async function storableForm(
  source: Buffer,
): Promise<{ bytes: Buffer; extension: string; contentType: string }> {
  const meta = await sharp(source).metadata();
  const known = STORABLE.find((f) => f.format === meta.format);
  if (known) {
    return { bytes: source, extension: known.extension, contentType: known.contentType };
  }
  return {
    bytes: await sharp(source).jpeg({ quality: 92 }).toBuffer(),
    extension: "jpg",
    contentType: "image/jpeg",
  };
}

/** One face the caller may pick, with the size that decided whether it can be. */
export interface PickableFace {
  index: number;
  box: FaceBox;
  score: number;
  /** The face's shorter side in pixels of the photograph. */
  pixels: number;
}

/**
 * What happened to one photograph.
 *
 * `pick-a-face` is not a failure: the caller did nothing wrong, meco simply
 * cannot know which of several people in the picture is the Person being
 * enrolled. It comes back with the faces so the same photograph can be sent
 * again with a `faceIndex`.
 */
export type Enrolment =
  | { status: "enrolled"; photo: ReferencePhoto }
  | { status: "pick-a-face"; width: number; height: number; faces: PickableFace[] };

function facePixels(face: DetectedFace, width: number, height: number): number {
  return Math.min(face.box.width * width, face.box.height * height);
}

export interface EnrolInput {
  brand: string;
  personId: string;
  /** The photograph itself. */
  source: Buffer;
  /** Which face, when the photograph has several. */
  faceIndex?: number;
  /** True when the enroller stated that this Person agreed. */
  consent?: boolean;
}

/**
 * Enrol one photograph as a Reference Photo of one Person.
 *
 * Detect, pick, measure, embed, store — in that order, and the store is written
 * only once every step before it has succeeded. A photograph that produced no
 * usable Face Print leaves nothing behind.
 *
 * The photograph is filed under the hash of its own bytes, so enrolling the same
 * picture twice replaces one record instead of making two.
 *
 * The Person record is read and written back, so two enrolments running at the
 * same instant could leave one of them off the list. That is bookkeeping, not
 * data: the bytes are under the Person's prefix either way, and it is the prefix
 * that `deletePerson` walks — so nothing can be stranded where deletion will not
 * reach it.
 *
 * Detection here is a direct call rather than a cached Annotation. An Annotation
 * is filed under the hash of the image in the public store; a Reference Photo is
 * personal data that must not leave a trail outside the People prefix, and one
 * detection per enrolment is a price worth paying for that.
 */
export async function enrolReferencePhoto(
  input: EnrolInput,
  storage: Storage,
): Promise<Enrolment> {
  const brand = requireBrand(input.brand);
  const person = await getPerson(brand, input.personId, storage);

  const detection = await detectFaces(input.source);
  const { width, height, faces } = detection;

  if (faces.length === 0) {
    throw new Error(
      "No face was found in this photograph, so there is nothing to enrol. " +
        "A Reference Photo has to show the Person's face.",
    );
  }

  if (input.faceIndex !== undefined && (input.faceIndex < 0 || input.faceIndex >= faces.length)) {
    throw new Error(
      `There is no face ${String(input.faceIndex)} in this photograph — it has ` +
        `${String(faces.length)}.`,
    );
  }

  if (input.faceIndex === undefined && faces.length > 1) {
    return {
      status: "pick-a-face",
      width,
      height,
      faces: faces.map((face, index) => ({
        index,
        box: face.box,
        score: face.score,
        pixels: Math.round(facePixels(face, width, height)),
      })),
    };
  }

  const index = input.faceIndex ?? 0;
  const face = faces[index]!;
  const pixels = facePixels(face, width, height);
  if (pixels < MIN_FACE_PX) {
    throw new Error(
      `That face is ${String(Math.round(pixels))} px across, and a Reference ` +
        `Photo needs at least ${String(MIN_FACE_PX)} px. Use a closer photograph.`,
    );
  }

  const [print] = await embedFaces(input.source, [{ landmarks: face.landmarks }]);
  if (!print) throw new Error("meco-faces returned no Face Print for that face.");

  const stored = await storableForm(input.source);
  const photoId = createHash("sha256").update(stored.bytes).digest("hex").slice(0, 32);
  const now = new Date().toISOString();

  await storage.putAt(
    photoKey(brand, person.id, photoId, stored.extension),
    stored.bytes,
    stored.contentType,
  );
  const printRecord: StoredFacePrint = {
    personId: person.id,
    photoId,
    print,
    printedAt: now,
  };
  await storage.putAt(
    printKey(brand, person.id, photoId),
    Buffer.from(JSON.stringify(printRecord)),
    "application/json",
  );

  const photo: ReferencePhoto = {
    photoId,
    face: face.box,
    format: stored.extension,
    enrolledAt: now,
    ...(input.consent ? { consentAt: now } : {}),
  };
  // The same photograph enrolled again replaces its entry rather than adding a
  // second one: the key is the same, so two entries would describe one object.
  person.photos = [...person.photos.filter((p) => p.photoId !== photoId), photo];
  await writePerson(person, storage);

  return { status: "enrolled", photo };
}

// -------------------------------------------------------------------- deleting

/**
 * Remove one Reference Photo, its Face Print and its entry on the Person.
 *
 * The record is rewritten last. A crash between the two deletes and the write
 * leaves an entry pointing at bytes that are gone, which reads as a missing
 * photo; the other order would leave bytes nothing points at, which reads as
 * nothing at all and is the one outcome personal data must not have.
 */
export async function deleteReferencePhoto(
  brand: string,
  personId: string,
  photoId: string,
  storage: Storage,
): Promise<Person> {
  const person = await getPerson(requireBrand(brand), personId, storage);
  const photo = requirePhoto(person, photoId);
  await storage.delete(photoKey(brand, personId, photoId, photo.format));
  await storage.delete(printKey(brand, personId, photoId));
  person.photos = person.photos.filter((p) => p.photoId !== photoId);
  await writePerson(person, storage);
  return person;
}

/**
 * Remove a Person and everything meco ever kept about them.
 *
 * Driven off a listing of the Person's own prefix rather than off the record's
 * list of photos, deliberately. The record is what a half-finished enrolment
 * could be missing an entry from; the prefix is what the bytes are actually
 * under. Deleting what is there is the only version of this that is a promise
 * about the store rather than about the bookkeeping.
 */
export async function deletePerson(
  brand: string,
  personId: string,
  storage: Storage,
): Promise<{ deleted: number }> {
  const person = await getPerson(requireBrand(brand), personId, storage);
  const objects = await storage.list(personPrefix(brand, person.id));
  for (const object of objects) {
    await storage.delete(object.key);
  }
  // The record itself, in case a backend's listing did not name it.
  await storage.delete(personKey(brand, person.id));
  return { deleted: objects.length };
}

/**
 * A Reference Photo named by URL — the only way an MCP client can send one, and
 * the JSON half of the HTTP route. The multipart half carries the same fields
 * as form parts.
 */
export const addReferencePhotoBody = z.object({
  brand: z.string(),
  source: z.string().url(),
  faceIndex: z.number().int().min(0).optional(),
  consent: z.boolean().optional(),
});

export type AddReferencePhotoInput = z.infer<typeof addReferencePhotoBody>;
