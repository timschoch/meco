/**
 * A Brand's People, their Reference Photos, and the Erasure that proves a
 * Person can be deleted whole.
 *
 * Three rules decide everything here.
 *
 * **The Face Print is a column, not a pointer into the Annotation**
 * ([ADR-0011](../../../docs/adr/0011-records-postgres-rows-counted-deletes-and-a-sweep.md),
 * Q13). The Annotation is shared bytes a newer Model may re-annotate and the
 * Sweep may remove; the print a Person was enrolled with is the Brand's own
 * fact and belongs beside the consent that allowed it.
 *
 * **The same bytes may be filed twice.** A photograph enrolled as a Reference
 * Photo lives at `people/<brand>/<personId>/<hash>.<ext>`, and the same bytes
 * may also be a Source Image at `sources/<hash>.<ext>`. One `files` row, two
 * Store Keys: the `reference_photos` row carries its own, the `files` row keeps
 * the source one (decision on #86).
 *
 * **Bytes go only at a Reference Count of zero.** The count of a File is its
 * rows in `sources` plus its rows in `reference_photos`; the count of a
 * Reference Photo's Store Key is the rows still naming that key. `store.delete`
 * is unconditional (ADR-0010), so the counting is here and nowhere else.
 */
import { FacePrint } from "@meco/contracts";
import type { Listing, Store } from "@meco/store";
import { and, eq, inArray } from "drizzle-orm";
import type { DatabaseDriver, Tx } from "./database";
import { unreferencedFile } from "./references";
import { files, people, referencePhotos } from "./schema";

/** A named individual one Brand enrolled. Personal data throughout. */
export interface Person {
  /** `crypto.randomUUID()`, minted by records. Path-safe: it lands in a key. */
  readonly id: string;
  readonly brand: string;
  readonly name: string;
  /** ISO 8601, as `@meco/store`'s Listing reports its own times. */
  readonly createdAt: string;
}

/** One photograph enrolled for one Person, with the print it was enrolled by. */
export interface ReferencePhoto {
  readonly id: string;
  readonly personId: string;
  readonly brand: string;
  /** The Content Hash of the bytes. A File with this hash must exist. */
  readonly hash: string;
  /** `people/<brand>/<personId>/<hash>.<ext>` — this photo's own key. */
  readonly storeKey: string;
  /** The Region identify chose in the Annotation of those bytes. */
  readonly regionId: string;
  readonly facePrint: FacePrint;
  /**
   * When the Person agreed, or `null`. records stores what the enroller says
   * and never fills it in (ADR-0003, Decision 2).
   */
  readonly consentAt: string | null;
  readonly createdAt: string;
}

export type NewReferencePhoto = Omit<
  ReferencePhoto,
  "id" | "createdAt" | "consentAt"
> & {
  /** ISO 8601. Absent when the enroller gave no date; never defaulted. */
  readonly consentAt?: string;
};

/** A Person with every print identify has to compare against. One read. */
export interface PersonWithPrints extends Person {
  readonly photos: readonly ReferencePhoto[];
}

/** What an Erasure removed, and the proof that nothing of it is left. */
export interface Erasure {
  /** The Person asked for, whether or not a row was there to delete. */
  readonly person: string;
  /** False when no such Person: an Erasure run twice is not an error. */
  readonly erased: boolean;
  /** How many Reference Photo rows went with the Person. */
  readonly photos: number;
  /** The Content Hashes whose File and Annotation reached a count of zero. */
  readonly files: readonly string[];
  /** The Store Keys whose bytes were deleted, in order. */
  readonly keys: readonly string[];
  /**
   * `store.list("people/<brand>/<personId>")` after the deletes, which is
   * empty. Not an assertion records makes but the listing itself: the bytes go
   * after the rows commit, so a store that refused one is visible here rather
   * than hidden behind a `true`.
   */
  readonly remaining: readonly Listing[];
}

/** What `unenrol` removed. A Person with another enrolment keeps its key. */
export interface Unenrolment {
  /** False when no such Reference Photo. Idempotent, as Erasure is. */
  readonly deleted: boolean;
  /**
   * The Store Keys whose bytes went — at most the photo's own. Empty while
   * another row names the key. Never a File's own key: that one is the Sweep's.
   */
  readonly keys: readonly string[];
}

export interface People {
  create(person: { brand: string; name: string }): Promise<Person>;
  get(brand: string, id: string): Promise<Person | null>;
  /** Every Person of one Brand with every Face Print, in one query. */
  list(brand: string): Promise<PersonWithPrints[]>;
  /** Requires a File for the hash: an enrolment of bytes records never saw is refused. */
  enrol(photo: NewReferencePhoto): Promise<ReferencePhoto>;
  /**
   * Deletes one Reference Photo, and its bytes only if no row still names
   * them. The File is left to the Sweep: the immediate cascade is Erasure's.
   */
  unenrol(brand: string, referencePhotoId: string): Promise<Unenrolment>;
  /** Deletes the Person, its Reference Photos, their orphaned Files and every byte. */
  erase(brand: string, id: string): Promise<Erasure>;
}

/**
 * The subtree every one of a Person's Store Keys sits under. Built here rather
 * than taken from a caller, because it is what the Erasure proof is listed
 * against: a prefix a caller could get wrong is a proof of the wrong subtree.
 */
export const peoplePrefix = (brand: string, personId: string): string =>
  `people/${brand}/${personId}`;

type PersonRow = Omit<Person, "createdAt"> & { readonly createdAt: Date };

const asPerson = (row: PersonRow): Person => ({
  id: row.id,
  brand: row.brand,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
});

type PhotoRow = {
  readonly id: string;
  readonly personId: string;
  readonly brand: string;
  readonly hash: string;
  readonly storeKey: string;
  readonly regionId: string;
  readonly facePrint: unknown;
  readonly consentAt: Date | null;
  readonly createdAt: Date;
};

const asReferencePhoto = (row: PhotoRow): ReferencePhoto => ({
  id: row.id,
  personId: row.personId,
  brand: row.brand,
  hash: row.hash,
  storeKey: row.storeKey,
  regionId: row.regionId,
  // Parsed, not cast: what came back is jsonb Postgres reassembled, and the
  // contracts schema is what says it is still a Face Print.
  facePrint: FacePrint.parse(row.facePrint),
  consentAt: row.consentAt === null ? null : row.consentAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
});

/**
 * The Files among these hashes that nothing names any more, with the Store Key
 * their bytes sit at. {@link unreferencedFile} is the Reference Count: a Source
 * Hold from any Brand, or a Reference Photo of any Person, keeps the File —
 * which is what stops an Erasure from deleting a source another Brand still
 * holds. The Sweep asks it of every File over the Retention Window instead.
 */
async function orphanedFiles(
  tx: Tx,
  hashes: readonly string[]
): Promise<{ hash: string; storeKey: string }[]> {
  if (hashes.length === 0) return [];
  return tx
    .select({ hash: files.hash, storeKey: files.storeKey })
    .from(files)
    .where(and(inArray(files.hash, [...hashes]), ...unreferencedFile(tx)));
}

/** The Reference Photo Store Keys among these that no row names any more. */
async function unreferencedKeys(
  tx: Tx,
  keys: readonly string[]
): Promise<string[]> {
  if (keys.length === 0) return [];
  const stillNamed = await tx
    .selectDistinct({ storeKey: referencePhotos.storeKey })
    .from(referencePhotos)
    .where(inArray(referencePhotos.storeKey, [...keys]));
  const named = new Set(stillNamed.map((row) => row.storeKey));
  return keys.filter((key) => !named.has(key));
}

export function peopleOver(driver: DatabaseDriver, store: Store): People {
  const { orm } = driver;

  const readPerson = async (
    brand: string,
    id: string
  ): Promise<Person | null> => {
    const [row] = await orm
      .select()
      .from(people)
      .where(and(eq(people.brand, brand), eq(people.id, id)))
      .limit(1);
    return row === undefined ? null : asPerson(row);
  };

  return {
    async create(person) {
      const [row] = await orm
        .insert(people)
        .values({ id: crypto.randomUUID(), ...person })
        .returning();
      if (row === undefined) {
        throw new Error(
          `@meco/records: the person for brand ${person.brand} was inserted and nothing came back.`
        );
      }
      return asPerson(row);
    },

    get: readPerson,

    async list(brand) {
      // One statement, because identify compares every face against every
      // print the Brand enrolled and a query per Person would be a round trip
      // per Person. The grouping is done here rather than by the database:
      // `json_agg` would put the shape back through jsonb for nothing.
      const rows = await orm
        .select({ person: people, photo: referencePhotos })
        .from(people)
        .leftJoin(referencePhotos, eq(referencePhotos.personId, people.id))
        .where(eq(people.brand, brand))
        // Ordered on the ids as well as the times, so two rows written in the
        // same transaction — and therefore at the same `now()` — still come
        // back in one order rather than the database's.
        .orderBy(
          people.createdAt,
          people.id,
          referencePhotos.createdAt,
          referencePhotos.id
        );

      const byPerson = new Map<string, Person & { photos: ReferencePhoto[] }>();
      for (const { person, photo } of rows) {
        let held = byPerson.get(person.id);
        if (held === undefined) {
          held = { ...asPerson(person), photos: [] };
          byPerson.set(person.id, held);
        }
        // A left join: a Person with no Reference Photo is one row with none.
        if (photo !== null) held.photos.push(asReferencePhoto(photo));
      }
      return [...byPerson.values()];
    },

    async enrol(photo) {
      const [row] = await orm
        .insert(referencePhotos)
        .values({
          id: crypto.randomUUID(),
          personId: photo.personId,
          brand: photo.brand,
          hash: photo.hash,
          storeKey: photo.storeKey,
          regionId: photo.regionId,
          // Refused on the way in as well as on the way out: a print that is
          // not on the unit sphere would compare against every Person at once.
          facePrint: FacePrint.parse(photo.facePrint),
          consentAt:
            photo.consentAt === undefined ? null : new Date(photo.consentAt),
        })
        .returning();
      if (row === undefined) {
        throw new Error(
          `@meco/records: the reference photo for person ${photo.personId} was inserted and nothing came back.`
        );
      }
      return asReferencePhoto(row);
    },

    async unenrol(brand, referencePhotoId) {
      const removed = await orm.transaction(async (tx) => {
        const [photo] = await tx
          .select({ storeKey: referencePhotos.storeKey })
          .from(referencePhotos)
          .where(
            and(
              eq(referencePhotos.brand, brand),
              eq(referencePhotos.id, referencePhotoId)
            )
          )
          .limit(1);
        if (photo === undefined) return null;

        await tx
          .delete(referencePhotos)
          .where(eq(referencePhotos.id, referencePhotoId));

        // The row goes, its Face Print with it, and the bytes once no row
        // names the key. The **File** stays: a `files` row nothing references
        // any more is what the Sweep is for, and the immediate cascade is
        // sanctioned for erasing a Person and for nothing else (#76, Q11).
        // Withdrawing one photograph from a Person who stays is not that.
        return unreferencedKeys(tx, [photo.storeKey]);
      });

      if (removed === null) return { deleted: false, keys: [] };
      // After the rows commit: the store is not in the transaction, so bytes
      // deleted before a rollback would be bytes a surviving row still names.
      for (const key of removed) await store.delete(key);
      return { deleted: true, keys: removed };
    },

    async erase(brand, id) {
      const erased = await orm.transaction(async (tx) => {
        const [person] = await tx
          .select({ id: people.id })
          .from(people)
          .where(and(eq(people.brand, brand), eq(people.id, id)))
          .limit(1);
        if (person === undefined) return null;

        const photos = await tx
          .select({
            hash: referencePhotos.hash,
            storeKey: referencePhotos.storeKey,
          })
          .from(referencePhotos)
          .where(eq(referencePhotos.personId, id));

        // The `reference_photos` rows go by cascade, so the Reference Counts
        // below are read after they are already gone.
        await tx.delete(people).where(eq(people.id, id));

        const hashes = [...new Set(photos.map((one) => one.hash))];
        const orphans = await orphanedFiles(tx, hashes);
        if (orphans.length > 0) {
          await tx.delete(files).where(
            inArray(
              files.hash,
              orphans.map((one) => one.hash)
            )
          );
        }

        const photoKeys = [...new Set(photos.map((one) => one.storeKey))];
        return {
          photos: photos.length,
          files: orphans.map((one) => one.hash),
          // Two kinds of key, and both have to go. The photo keys are under
          // this Person's prefix. An orphaned File's own key is not — for a
          // photograph that was also a Source Image it is `sources/<hash>`,
          // and once the row is gone the Sweep can never find those bytes
          // again, because the Sweep reads rows.
          keys: [
            ...new Set([
              ...(await unreferencedKeys(tx, photoKeys)),
              ...orphans.map((one) => one.storeKey),
            ]),
          ],
        };
      });

      const prefix = peoplePrefix(brand, id);
      if (erased === null) {
        return {
          person: id,
          erased: false,
          photos: 0,
          files: [],
          keys: [],
          remaining: await store.list(prefix),
        };
      }
      for (const key of erased.keys) await store.delete(key);
      return {
        person: id,
        erased: true,
        ...erased,
        remaining: await store.list(prefix),
      };
    },
  };
}
