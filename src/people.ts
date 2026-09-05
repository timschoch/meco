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
import {
  detectFaces,
  embedFaces,
  sentScale,
  type DetectedFace,
  type EmbeddedFaces,
  type FaceBox,
} from "./faces.js";
import { NOT_A_FACE_PRINTS } from "./not-a-face-prints.js";
import { PRIVATE_PREFIX, type Storage } from "./storage.js";

/**
 * How small a face may be and still be worth enrolling, in pixels of the copy
 * meco-faces is given.
 *
 * EdgeFace is trained on 112×112 crops. A face smaller than this is upsampled
 * into the network, and what comes back is a Face Print of the interpolation
 * rather than of the person — it compares cleanly against everything and
 * identifies nobody. Refusing is the honest answer; the fix is a better
 * photograph, and only the caller has one.
 *
 * Of the copy and not of the Source Image, because it is the copy that gets
 * upsampled: meco bounds a photograph to `LONG_EDGE` on the way out (see
 * `./faces.js`), so a 60 px face in a 4000 px photograph arrives as 24 px. Judged
 * in the photograph's own frame this rule would pass exactly the faces it exists
 * to refuse.
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

/**
 * How alike a Face Print must be to a Not-a-Face Print before meco refuses to
 * read any identity out of it at all.
 *
 * ## Why a threshold on a print, and not on the landmarks or the score
 *
 * Issue #34 asked for a geometry check on YuNet's five points, on the reasoning
 * that they must be arbitrary on the back of a helmet. Measured over every
 * committed fixture, they are not: the landmark head emits a face-shaped
 * configuration whatever it is looking at. In an interocular-normalised frame
 * `on-track-rear-helmet` sits *inside* the real-face envelope and is less
 * extreme than two of the faces in `paddock-mixed` on both axes — nose asymmetry
 * 0.356 against their 0.442 and 0.413, mouth drop 1.06 against their 1.46 and
 * 1.53. Any cutoff that rejects the helmet rejects those two first. `pnpm
 * test:match` recomputes this from the committed landmarks, so the verdict
 * cannot quietly stop being true. The detection score (helmets 0.649 and 0.808 against
 * real faces 0.661 to 0.947), the raw embedding magnitude (0.27 to 0.30 against
 * 0.27 to 0.34) and flip consistency (the helmet is the *most* consistent of the
 * 21 at 0.9987) were measured too and separate no better.
 *
 * What does separate is the Face Print, because the thing EdgeFace does to a
 * non-face is the whole defect: it maps every head with no face turned to the
 * camera close to every other one. That collapse makes helmets match each other
 * at 0.907 (`docs/research/kart-and-driver-subjects.md`, 36 pairs), and it is
 * also what makes them recognisable — a print near a committed Not-a-Face Print
 * names nobody, whoever is under the helmet.
 *
 * ## Where 0.60 comes from
 *
 * Measured against the one committed Not-a-Face Print, over every kart and face
 * fixture, counting only detections that clear `MIN_FACE_PX`:
 *
 * - 11 real faces of 57 px or more score **0.0971** at worst.
 * - Two real faces between 40 and 57 px score **0.2329** and **0.5601** — the
 *   second is the driver in `paddock-mixed` with the visor up, which is exactly
 *   the Swiss Hutless case and must go on being recognisable. That 0.5601 is the
 *   whole of the tightness below, and it belongs to a 49 px face.
 * - `on-track-visor-open`, a different helmet held out of the reference set,
 *   scores **0.6935**. `paddock-mixed`'s man seen from behind scores 0.7457.
 *   Both are rejections measured out of sample rather than assumed.
 * - Against the eight other helmets of the research document's nine, measured
 *   for #40 rather than deduced: **0.7092 at worst, eight of eight caught**.
 *   Seven of those eight are CC BY-SA and cannot be committed, so `pnpm
 *   test:match` quotes that figure and labels it as recorded; the one that is
 *   committed is the 0.6935 above, and the two agree within the noise a JPEG
 *   re-encode puts on a print.
 *
 * So 0.60 can **rise by 0.0935** before it stops refusing the nearest non-face,
 * and **fall by only 0.0399** before it starts refusing the closest real face.
 * **The binding constraint is real faces, not helmets** — the tight side is the
 * one where the mistake is a face going unnamed. Do not read the two as a band
 * with the threshold in the middle: an earlier version of this comment did, off
 * a number that was never about this reference, and that reading invites
 * tightening in the direction that starts refusing real people. ADR-0003's
 * amendment has the full account.
 *
 * Both numbers are tighter than `MATCH_THRESHOLD`'s 0.2145 and 0.2304, and the
 * tightness is real rather than hidden: below about 57 px a small face and a
 * helmet are genuinely hard to tell apart by print.
 *
 * **0.60 is a rounded constant, not a tuned one.** ADR-0003 measured one pair
 * moving **0.019** across JPEG encodes of the same pixels — about half the
 * clearance below — so the fourth decimal of anything here is noise, and a
 * threshold quoted to four decimals would claim precision the input lacks.
 *
 * It is shipped at that margin because the two mistakes are not the same size. A
 * face wrongly called a Not-a-Face is never a Match, so it is blurred and not
 * pinned on — cautious. A Not-a-Face wrongly taken for a face is a stranger's
 * name in a published post with their face left sharp, which is the failure
 * issue #34 reported from production. The tight side is the cautious one, which
 * is the right way round.
 */
export const NOT_A_FACE_THRESHOLD = 0.6;

/** What a Face Print turned out to resemble, when it resembles a Not-a-Face. */
export interface NotAFace {
  /** Which committed print, so a refusal can be traced to a fixture. */
  name: string;
  /** What a human saw there — "back of the helmet". */
  what: string;
  score: number;
}

/**
 * What this Face Print is, if it is not a face — otherwise null.
 *
 * Null is the ordinary answer and the one every real face gets. Returning the
 * resemblance rather than a boolean is what lets an enrolment refusal say what
 * meco thinks it is looking at, which is the difference between a caller fixing
 * their photograph and a caller filing a bug.
 */
export function notAFace(print: readonly number[]): NotAFace | null {
  let closest: NotAFace | null = null;
  for (const reference of NOT_A_FACE_PRINTS) {
    const score = cosineSimilarity(print, reference.print);
    if (score >= NOT_A_FACE_THRESHOLD && (!closest || score > closest.score)) {
      closest = { name: reference.name, what: reference.what, score };
    }
  }
  return closest;
}

/**
 * The face's shorter side in pixels, in the frame `MIN_FACE_PX` is judged in.
 *
 * One function for enrolling and for matching, because it is one rule: below
 * this size EdgeFace is handed an upsampled blur, and the print it returns
 * describes the interpolation rather than the person.
 */
function facePixels(face: DetectedFace, width: number, height: number): number {
  return Math.min(face.box.width * width, face.box.height * height) * sentScale(width, height);
}

/**
 * Whether this is an Identifiable Face — one meco is willing to compare
 * against a Person at all.
 *
 * Two conditions and they are not independent — the second is only trustworthy
 * because of the first. `MIN_FACE_PX` was written for enrolment and its reasoning
 * has always applied here too: a print of a 36 px face compares cleanly against
 * everything and identifies nobody. It is also what keeps the Not-a-Face
 * threshold honest, since it is under 57 px that a real face starts drifting
 * towards the Not-a-Face Print — `paddock-mixed`'s 36 px child reaches 0.6920,
 * which no threshold could tell from a helmet.
 *
 * A face that fails is still detected, still a Subject Box, and still hidden by
 * Face Blur. The only thing it loses is the ability to become a Match.
 */
export function whyNotIdentifiable(
  face: DetectedFace,
  print: readonly number[],
  width: number,
  height: number,
): string | null {
  const pixels = facePixels(face, width, height);
  if (pixels < MIN_FACE_PX) {
    return (
      `it is ${String(Math.round(pixels))} px across and meco does not recognise ` +
      `anyone below ${String(MIN_FACE_PX)} px`
    );
  }
  const resemblance = notAFace(print);
  if (resemblance) {
    return (
      `meco cannot see a face there — it looks like the ${resemblance.what} ` +
      `(${resemblance.score.toFixed(4)} against ${resemblance.name}, refused at ` +
      `${String(NOT_A_FACE_THRESHOLD)})`
    );
  }
  return null;
}

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
  /**
   * Size of the Source Image as a viewer sees it, which is what `MIN_FACE_PX` is
   * judged in. The faces are fractions and say nothing about how big they are.
   */
  width: number;
  height: number;
  faces: readonly DetectedFace[];
  /** Limit the answer to these Person ids. */
  persons?: readonly string[];
}

export interface FaceMatches {
  /** One entry per face, in the order they were given. `null` is "unknown". */
  matches: (Match | null)[];
  /** Empty unless something a caller should hear about went wrong. */
  warnings: string[];
  /**
   * How many Uncompared Faces there are: faces never compared against the
   * Brand's People at all, because meco-faces could not embed them or because
   * the call failed.
   *
   * Zero is the ordinary answer. It is a count rather than only a warning
   * because "nobody in this photograph is enrolled" and "meco could not look at
   * one of these faces" are different answers that otherwise arrive identically,
   * and a caller cannot be asked to tell them apart by reading prose.
   *
   * Not the same as an unknown face. An unknown face was compared and matched
   * nobody, which is the common and correct answer; an Uncompared Face was never
   * asked about. Both are hidden by Face Blur, and neither is ever a Match.
   */
  facesNotCompared: number;
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
 *
 * Two things are checked before any name is handed out, and both are new in
 * issue #34: the enrolled prints, so a Reference Photo that is not a face cannot
 * lend its name to anybody, and each detection, so a face meco cannot read an
 * identity out of is unknown rather than whoever it happened to be nearest.
 */
export async function matchFaces(input: MatchInput, storage: Storage): Promise<FaceMatches> {
  const brand = requireBrand(input.brand);
  if (input.faces.length === 0) return { matches: [], warnings: [], facesNotCompared: 0 };

  const stored = await facePrintsFor(brand, storage);

  /**
   * Reference Photos whose Face Print is not an Identifiable Face, dropped before
   * anything is compared against them.
   *
   * The gallery is checked as well as the detection, and neither is enough
   * alone. A Brand enrolled its People before this rule existed, so it may hold
   * a print of a helmet — that is exactly the record issue #34 was reproduced
   * with. And the two failures are different: a helmet detection against a real
   * Person is already safe (helmet against face is 0.433 at worst over the
   * research document's 108 pairs, under `MATCH_THRESHOLD`), but a *real* face
   * against an enrolled helmet is not — `paddock-mixed`'s driver scores 0.5601
   * against the committed Not-a-Face Print, which clears 0.50. Only dropping the
   * record stops meco putting "Helmet A" on a real person.
   *
   * A warning rather than a silent skip: the Brand's owner enrolled that
   * photograph and is the only one who can replace it.
   */
  const unusable: EnrolledPrint[] = [];
  const enrolled: EnrolledPrint[] = [];
  for (const record of stored) {
    (notAFace(record.print) ? unusable : enrolled).push(record);
  }
  const galleryWarnings = unusable.map(
    (record) =>
      `"${record.personName}" has a Reference Photo that is not a face (${record.photoId}), ` +
      "so it was left out of the comparison. Re-enrol that Person from a photograph " +
      "showing their face.",
  );

  // Against everything the Brand has enrolled, not against what survived the
  // filter: a Person whose only Reference Photo is unusable does exist, and
  // telling their caller "no such Person" would send them looking for a typo.
  // They simply cannot be matched, which the warning above already says.
  if (input.persons) {
    const known = new Set(stored.map((e) => e.personId));
    const unknown = input.persons.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `No enrolled Person in "${brand}" with id ${unknown.map((id) => `"${id}"`).join(", ")}. ` +
          "Only a Person of this Brand with at least one Reference Photo can be matched.",
      );
    }
  }

  const none = {
    matches: input.faces.map(() => null),
    warnings: galleryWarnings,
    facesNotCompared: 0,
  };
  if (enrolled.length === 0) return none;

  let embedded: EmbeddedFaces;
  try {
    embedded = await embedFaces(
      input.source,
      input.faces.map((face) => ({ landmarks: face.landmarks })),
    );
  } catch (err) {
    // The whole call failed — the service is down, or the photograph is not one.
    // Every face is uncompared, which is what `notCompared` has to say: a Crop
    // that names nobody because nothing was asked is not the same answer as one
    // that names nobody because nobody is enrolled.
    return {
      ...none,
      warnings: [...galleryWarnings, `No faces were named: ${(err as Error).message}`],
      facesNotCompared: input.faces.length,
    };
  }

  /**
   * The Uncompared Faces, counted off the answer rather than off the report.
   *
   * A hole in `prints` is the fact; `uncompared` is meco-faces describing it.
   * They should agree and the count is taken from the holes, because that is
   * what matching actually acted on — an older service that answered with a
   * `null` and no explanation would otherwise be reported as nothing wrong,
   * which is the exact silence issue #39 exists to end.
   */
  const holes = embedded.prints.filter((print) => print === null).length;

  /**
   * One warning, listing every distinct reason rather than the first.
   *
   * Two faces can fail for different reasons — the warp refuses landmarks that
   * collapse, that fall outside the image, and that warp too small — so quoting
   * `uncompared[0]` alone would report one cause for a photograph that had
   * several. One line per face would instead push the Crop's own warnings out of
   * sight in a group photograph, so the reasons are gathered and said once.
   *
   * Before issue #39 none of this could happen: a single unalignable face
   * rejected the whole request, so this was the `catch` above and every face in
   * the photograph was lost with it.
   */
  const reasons = [...new Set(embedded.uncompared.map((face) => face.reason))];
  const skippedWarnings =
    holes === 0
      ? []
      : [
          `${String(holes)} of ${String(input.faces.length)} faces could not be compared ` +
            `against this Brand's People` +
            (reasons.length > 0 ? `: ${reasons.join(" ")}` : ".") +
            " They are unknown rather than unmatched, so Face Blur still hides them.",
        ];

  // Every face is embedded, and only then asked whether it may carry a name.
  // The print is what the question is about, so it has to exist before it can be
  // answered — and the face keeps its place in the list either way, because
  // `unknownFaces` in `./face-blur.js` reads this by position and a shortened
  // list would blur the wrong faces.
  return {
    matches: embedded.prints.map((print, i) =>
      print !== null &&
      whyNotIdentifiable(input.faces[i]!, print, input.width, input.height) === null
        ? matchFacePrint(print, enrolled, input.persons)
        : null,
    ),
    warnings: [...galleryWarnings, ...skippedWarnings],
    facesNotCompared: holes,
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
  /**
   * The face's shorter side in pixels, in the frame `MIN_FACE_PX` is judged in —
   * the copy meco-faces is given, which for a photograph over `LONG_EDGE` is
   * smaller than the photograph. It is here so a caller can see why a face was
   * refused, and it orders the faces the same way either frame would.
   */
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

  const embedded = await embedFaces(input.source, [{ landmarks: face.landmarks }]);
  const print = embedded.prints[0];
  if (!print) {
    // A hole is an answer at match time and a refusal here: enrolling is the one
    // path with nothing to fall back to, and a Person recorded without a Face
    // Print is a Person meco can never recognise. The reason comes from
    // meco-faces, because only it knows why its warp refused the landmarks.
    throw new Error(
      "meco could not read a Face Print from that face" +
        (embedded.uncompared[0] ? `: ${embedded.uncompared[0].reason}` : ".") +
        " Use a photograph where the face is larger and turned towards the camera.",
    );
  }

  /**
   * A detection the detector was confident about but that holds no identity.
   *
   * Refused here and not merely ignored later, because this is the cheapest
   * place in the whole system to stop it: a Reference Photo that is not a face
   * is a Person record that will name strangers for as long as it exists, and
   * issue #34 was reproduced by enrolling exactly one of these — the back of a
   * crash helmet — after which a different human matched it at 0.7092.
   *
   * The size rule above has already run, so what is left here is the print. Both
   * are asked again at match time; see `whyNotIdentifiable`, which is the same
   * question and the reason a Brand enrolled before this existed is safe too.
   *
   * ## A driver in a helmet cannot be enrolled, and that is the trade
   *
   * `on-track-visor-open.jpg` is a real driver with the visor up and his face
   * visible, and it scores **0.6935** against the committed Not-a-Face Print. So
   * it is refused — and it is exactly the photograph a karting brand posts every
   * weekend.
   *
   * **The visor is not what decides it; how much of the box is helmet is.**
   * `NOT_A_FACE_THRESHOLD` records `paddock-mixed`'s visor-up driver at 0.5601,
   * accepted, and he must go on being recognisable. He is photographed from the
   * front at conversational distance, so the open visor fills most of the box
   * and the shell is mostly outside it; the on-track driver's box is shell, chin
   * bar and visor surround with the face a small part of it. A refusal that said
   * "a visor is no good" would be telling a brand something false.
   *
   * That is not a hole in the rule, it is the rule: enrolling this would put a
   * print in the gallery that names every other helmeted stranger, which is
   * issue #34. ADR-0003 carries the full ledger.
   *
   * It is written here because somebody will try exactly this and be told no,
   * which is why the message names what meco thinks it sees, says it is a limit,
   * and describes the photograph that would work.
   */
  const notIdentifiable = notAFace(print);
  if (notIdentifiable) {
    throw new Error(
      "meco cannot see a face here that it could recognise anyone by — what it finds " +
        `looks like the ${notIdentifiable.what} (${notIdentifiable.score.toFixed(4)} against ` +
        `${notIdentifiable.name}, refused at ${NOT_A_FACE_THRESHOLD.toFixed(2)}). This is a ` +
        "limit rather than a fault: the more of the frame a crash helmet fills, the less " +
        "of a person is left to tell one from another, and a Face Print taken from one " +
        "would match strangers. Use a Reference Photo with the helmet off — or one taken " +
        "close and square on, so the face fills the box rather than the shell.",
    );
  }

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
