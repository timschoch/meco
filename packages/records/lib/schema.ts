/**
 * Every table records owns, in one place, so `drizzle-kit generate` can see the
 * whole schema and the first migration creates all of it. Only `files` and
 * `annotations` have methods in this slice; the rest are here so that later
 * tickets add methods rather than migrations.
 *
 * Two rules decide every column ([ADR-0011](../../../docs/adr/0011-records-postgres-rows-counted-deletes-and-a-sweep.md)):
 * a shape another module owns is `jsonb` and is parsed with that module's
 * schema on read; anything records filters or joins on is a column. No column
 * anywhere holds a URL — `store.publicUrl(key)` is arithmetic (ADR-0010).
 *
 * Closed sets — a Call's `kind`, its `status`, an Output's `kind` — are `text`
 * rather than a Postgres enum. The set is already written down once in
 * TypeScript and checked on the way in; an enum type would be a second copy of
 * it, and every value added would become a migration that buys no query.
 */
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** The Content Hash: 64 lowercase hex characters, never truncated. */
const hash = () => text().notNull();

const createdAt = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

/**
 * One photograph's bytes as records knows them. One row per Content Hash,
 * shared by every Brand, whether the bytes arrived as a Source Image or as a
 * Reference Photo.
 */
export const files = pgTable("files", {
  hash: text("hash").primaryKey(),
  mime: text("mime").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  bytes: integer("bytes").notNull(),
  storeKey: text("store_key").notNull(),
  firstSeenAt: createdAt("first_seen_at"),
});

/**
 * The contracts Annotation, stored as contracts defines it. `schema` and
 * `produced_by` are columns as well as fields of the document, because
 * `isComplete` and the re-annotate rule have to be a query.
 *
 * The Annotation dies with its File: a stranger's Face Print lives inside it,
 * and ADR-0011 gives that print exactly the lifetime of the photograph.
 */
export const annotations = pgTable("annotations", {
  hash: text("hash")
    .primaryKey()
    .references(() => files.hash, { onDelete: "cascade" }),
  schema: integer("schema").notNull(),
  producedBy: jsonb("produced_by").notNull(),
  annotation: jsonb("annotation").notNull(),
  annotatedAt: createdAt("annotated_at"),
});

/** A Brand. Its id is the slug compose keys a Look on. */
export const brands = pgTable("brands", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt("created_at"),
});

/**
 * A Source Hold: one Brand has used one Source Image. It authorises a Signed
 * URL for that Brand and it keeps the File alive.
 *
 * No cascade from `files`: a File a Brand still holds must not be deletable,
 * and the Sweep only ever looks at Files with no hold at all.
 */
export const sources = pgTable(
  "sources",
  {
    brand: text("brand")
      .notNull()
      .references(() => brands.id),
    hash: hash().references(() => files.hash),
    firstUsedAt: createdAt("first_used_at"),
  },
  (t) => [primaryKey({ columns: [t.brand, t.hash] }), index().on(t.hash)]
);

/** A bearer key as records knows it. The key itself is never stored. */
export const callers = pgTable("callers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  brands: text("brands").array().notNull(),
  createdAt: createdAt("created_at"),
});

export const people = pgTable(
  "people",
  {
    id: text("id").primaryKey(),
    brand: text("brand")
      .notNull()
      .references(() => brands.id),
    name: text("name").notNull(),
    createdAt: createdAt("created_at"),
  },
  (t) => [index().on(t.brand)]
);

/**
 * A Reference Photo: a File like any other, plus the Person it was enrolled
 * for, the Region identify chose, the Face Print it computed and the consent
 * that allowed it.
 *
 * `face_print` is a column and not a pointer into the Annotation: the
 * Annotation is shared bytes a newer Model may re-annotate, while the print a
 * Person was enrolled with is the Brand's own fact and stays beside
 * `consent_at`. records never fills `consent_at` (ADR-0003).
 */
export const referencePhotos = pgTable(
  "reference_photos",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    brand: text("brand")
      .notNull()
      .references(() => brands.id),
    hash: hash().references(() => files.hash),
    storeKey: text("store_key").notNull(),
    regionId: text("region_id").notNull(),
    facePrint: jsonb("face_print").notNull(),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    createdAt: createdAt("created_at"),
  },
  (t) => [index().on(t.personId), index().on(t.hash)]
);

/**
 * One request that entered the gateway. A failed Call is a Call.
 *
 * `source_hash` names a File without referencing it: the Reference Count is
 * Source Holds plus Reference Photos, so a foreign key here would let an old
 * Call block the Sweep.
 */
export const calls = pgTable(
  "calls",
  {
    id: text("id").primaryKey(),
    callerId: text("caller_id")
      .notNull()
      .references(() => callers.id),
    brand: text("brand")
      .notNull()
      .references(() => brands.id),
    kind: text("kind").notNull(),
    sourceHash: text("source_hash"),
    request: jsonb("request"),
    framing: jsonb("framing"),
    matches: jsonb("matches"),
    redactions: jsonb("redactions"),
    steps: jsonb("steps"),
    /** Opaque until pricing exists: records stores it and returns it unread. */
    cost: jsonb("cost"),
    error: jsonb("error"),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    durationMs: integer("duration_ms"),
  },
  (t) => [index().on(t.brand, t.startedAt), index().on(t.sourceHash)]
);

/**
 * One Render, Crop or Carousel a Brand owns. Keyed by `(brand, request_hash)`,
 * which is what the Replay looks up: one Brand asking two different things may
 * get byte-identical bytes back, and those are two Outputs on one Store Key
 * (#223).
 *
 * `store_key` is therefore a column and not part of the key, so byte-identical
 * outputs are rows on one key whether they belong to two Brands or to one. The
 * bytes go only when the last of those rows goes, and the count that decides
 * that is a count of rows on the key.
 */
export const outputs = pgTable(
  "outputs",
  {
    brand: text("brand")
      .notNull()
      .references(() => brands.id),
    storeKey: text("store_key").notNull(),
    callId: text("call_id")
      .notNull()
      .references(() => calls.id),
    kind: text("kind").notNull(),
    placement: text("placement"),
    requestHash: text("request_hash").notNull(),
    createdAt: createdAt("created_at"),
  },
  (t) => [
    // The Replay lookup reads this one, so it needs no index of its own.
    primaryKey({ columns: [t.brand, t.requestHash] }),
    // What `outputs.delete` narrows on before it counts.
    index().on(t.brand, t.storeKey),
    // The Reference Count and the Sweep's guard, both of which ask across
    // every Brand which rows still name a key.
    index().on(t.storeKey),
    // The Gallery's order, down to the tiebreak that makes it total.
    index().on(t.createdAt, t.storeKey, t.requestHash),
  ]
);
