# Spec: the records module

Parent: [Module: records (#86)](https://github.com/timschoch/meco/issues/86). Settles [The records schema (#76)](https://github.com/timschoch/meco/issues/76). Reasons: [ADR-0011](../adr/0011-records-postgres-rows-counted-deletes-and-a-sweep.md). Vocabulary: [`CONTEXT.md`, records](../../CONTEXT.md#records). Contracts: [`contracts.md`](contracts.md). Store: [`store.md`](store.md). Neon facts: [`../research/neon-on-vercel.md`](../research/neon-on-vercel.md), [Move every store of personal data to the EU (#98)](https://github.com/timschoch/meco/issues/98). Package layout: [`packages/README.md`](../../packages/README.md).

## Problem statement

Eight modules produce facts and none of them keeps any. models finds Regions and forgets them. frame chooses a window and forgets it. The store holds bytes and knows nothing about who may see them or whether anyone still needs them. Without one module that remembers, the same photograph is analysed on every call, a retry costs a second inference, the Gallery has nothing to list, a Signed URL for a Source Image cannot be authorised, and deleting a Person is a promise no test can check.

## Solution

One package, `@meco/records`, in front of one Postgres database on Neon in `eu-central-1`. It holds every File by Content Hash with its Annotation, every Call with its Steps, every Output a Brand owns, and a Brand's People, Reference Photos and Callers. It is the only module that writes to the database and the only one webui reads. It deletes bytes through the store only when the Reference Count is zero, and it runs the Sweep that stops a stranger's Face Print from living forever.

Two database adapters sit behind one interface and pass the same Conformance Checks: Neon over `pg`, and pglite in-process for the gate.

## User stories

1. As the gateway, I want the cached Annotation for a Content Hash, so that a photograph seen before is not sent to models again.
2. As the gateway, I want to know whether a cached Annotation is complete for the Models I need, so that a Model added since is a miss and never a wrong answer.
3. As the gateway, I want to look a Caller up by its bearer key once per request and get its Brands, so that the Brand wall is a lookup and not a config file.
4. As the gateway, I want to record one Call with what was asked, what every module answered and how long each Step took, so that the webui can show what happened.
5. As the gateway, I want a failed Call recorded with which module failed and why, so that a failure is visible and not a gap in the Gallery.
6. As the gateway, I want the same request twice to find its existing Output by Request Hash, so that a retry is free.
7. As the gateway, I want to ask whether a Brand holds a Source Image, so that I mint a Signed URL only to a Brand that has used that photograph.
8. As a Brand, I want my Outputs listed newest first, narrowed to a Placement or a kind, so that the Gallery shows what I made.
9. As a Brand, I want deleting my Output to leave another Brand's identical Output reachable, so that a shared Store Key is never deleted under someone else.
10. As identify, I want a Brand's People with their Face Prints in one read, so that a Match is computed against every Reference Photo the Brand enrolled.
11. As identify, I want to enrol a Reference Photo with the Region I chose, its Face Print and when consent was given, so that the enrolment is one row and one fact.
12. As the owner, I want deleting a Person to remove every Reference Photo row, every Face Print and every byte under that Person's prefix, and to prove it, so that ADR-0003's promise is a test that can fail.
13. As the owner, I want Files nobody has held for thirty days removed with their Annotation and bytes, so that a stranger's Face Print does not outlive the photograph's use.
14. As the owner, I want to change the Retention Window without a code change, so that a data-protection decision is a configuration value.
15. As the owner, I want the three Brands and the first Caller created by a script from a key I set, so that the first call can exist before the first row does.
16. As a developer, I want the whole suite to run in the gate with no network, so that a records test never reaches Neon by accident.
17. As a developer, I want the identical suite to run against Neon on demand, so that a difference between pglite and Neon is a red test and not a production surprise.
18. As the owner, I want `GET /health` to report whether the database is reachable and its migrations current, so that a container that booted against an old schema says so.
19. As any module author, I want records to hand me contracts types and plain rows, never a database type, so that the seam does not carry drizzle.
20. As a future pricing author, I want a place on the Call for what it cost, so that pricing lands as a column already there and not a migration.

## Implementation decisions

### The exported surface

```ts
// packages/records/index.ts
export function records(options: RecordsOptions): Records;
export function neonDatabase(connectionString: string): Database; // pg.Pool on the unpooled URL
export function pgliteDatabase(): Database; // in-process, in the gate

export interface RecordsOptions {
  database: Database;
  store: Store; // for cascades and the Sweep; records never reads bytes
  retentionDays?: number; // Retention Window, default 30
}

export interface Records {
  migrate(): Promise<{ applied: number }>; // boot; pg_advisory_lock; throws on failure

  files: {
    ensure(file: NewFile): Promise<FileRecord>; // idempotent on hash
    get(hash: string): Promise<FileRecord | null>;
  };
  annotations: {
    get(hash: string): Promise<Annotation | null>; // parsed with the contracts schema
    put(annotation: Annotation): Promise<void>; // replaces; requires the File
  };
  sources: {
    hold(brand: string, hash: string): Promise<void>; // idempotent
    heldBy(brand: string, hash: string): Promise<boolean>;
    release(brand: string, hash: string): Promise<void>;
  };
  brands: {
    ensure(brand: { id: string; name: string }): Promise<Brand>;
    get(id: string): Promise<Brand | null>;
    list(): Promise<Brand[]>;
  };
  callers: {
    create(caller: {
      name: string;
      key: string;
      brands: string[];
    }): Promise<Caller>; // stores the hash, never the key
    byKey(key: string): Promise<Caller | null>;
    grant(grant: { callerId: string; brands: string[] }): Promise<Caller>; // idempotent, additive; never removes a Brand
  };
  people: {
    create(person: { brand: string; name: string }): Promise<Person>;
    get(brand: string, id: string): Promise<Person | null>;
    list(brand: string): Promise<PersonWithPrints[]>; // one read for identify
    enrol(photo: NewReferencePhoto): Promise<ReferencePhoto>;
    unenrol(brand: string, photoId: string): Promise<Unenrolment>; // one photo
    erase(brand: string, id: string): Promise<Erasure>;
  };
  calls: {
    record(call: NewCall): Promise<Call>;
    get(id: string): Promise<Call | null>;
    list(query: {
      brand?: string;
      status?: CallStatus; // `?status=failed` on the Calls list
      limit: number;
      cursor?: string;
    }): Promise<Page<Call>>;
  };
  outputs: {
    record(output: NewOutput): Promise<Output>;
    byRequest(brand: string, requestHash: string): Promise<Output | null>;
    list(query: OutputQuery): Promise<Page<Output>>; // the Gallery
    delete(
      brand: string,
      storeKey: string
    ): Promise<{ deleted: boolean; bytesDeleted: boolean }>;
  };
  requestHash(brand: string, kind: CallKind, request: unknown): string;
  sweep(now?: Date): Promise<SweepReport>; // `now` is what the window is measured from
  close(): Promise<void>;
}

export const DEFAULT_RETENTION_DAYS = 30;

export interface SweepReport {
  sweptAt: string; // ISO 8601, the instant handed in
  retentionDays: number; // the window as configured, not as defaulted
  files: string[]; // the Content Hashes whose File and Annotation went
  keys: string[]; // the Store Keys whose bytes went, in order
}

// packages/records/health.ts
export interface RecordsReach {
  configured: boolean;
  reachable: boolean;
  serverVersion: string | null;
  pending: number | null; // migrations in the folder not yet applied
  roundTripMs: number | null;
}
export function reachRecords(records: Records): Promise<RecordsReach>;

// packages/records/conformance.ts
export interface Check {
  name: string;
  run(): Promise<void>;
}
export function recordsConformance(
  open: () => Promise<Records>,
  fixtures: RecordsFixtures
): Check[];
```

Three root files, as store has: the runtime surface, the health probe and the checks. Every method takes and returns contracts types or plain row types declared in `index.ts`. No drizzle type crosses the seam.

### Engine, driver and migrations

- drizzle-orm over `pg` `Pool` on `RECORDS_DATABASE_URL_UNPOOLED`. A container holds its own pool, so PgBouncer buys nothing and its transaction-mode limits would cost `SET` and advisory locks (research, section 1). `@neondatabase/serverless` is out: its pool may not outlive one request.
- Pool size 5. Neon free tier allows roughly 100 connections; two containers at 5 leave room for a migration and a developer.
- Schema in TypeScript, `drizzle-kit generate` SQL files committed under the package, applied with drizzle's `migrate()`. `push` is out: it leaves no history.
- `migrate()` runs at gateway boot, inside `pg_advisory_lock`, so two instances starting together apply once. A failed migration is a failed boot, loudly. Boot-time rather than a CI job because Vercel builds and promotes on push with no step we own between the two; the image and the schema it needs land together.
- Second `migrate()` on an applied folder is a no-op. Measured 6 Sep 2026 in `.temp/records-proto` (drizzle-orm 0.45.2, drizzle-kit 0.31.10, pglite 0.5.8, Node 26.7, this laptop): first migrate of the ten tables 48 ms on pglite, second 2 ms.

### The tables

| Table              | Key                       | Holds                                                                                                                                                                                                 | Brand-scoped |
| ------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `files`            | `hash`                    | `mime`, `width`, `height`, `bytes`, `store_key`, `first_seen_at`                                                                                                                                      | no           |
| `annotations`      | `hash` → `files`, cascade | `schema`, `produced_by` jsonb, `annotation` jsonb, `annotated_at`                                                                                                                                     | no           |
| `sources`          | `(brand, hash)`           | `first_used_at`                                                                                                                                                                                       | yes          |
| `brands`           | `id`                      | `name`, `created_at`                                                                                                                                                                                  | is the Brand |
| `callers`          | `id`                      | `name`, `key_hash` unique, `brands text[]`, `created_at`                                                                                                                                              | holds Brands |
| `people`           | `id`                      | `brand` → `brands`, `name`, `created_at`                                                                                                                                                              | yes          |
| `reference_photos` | `id`                      | `person_id` → `people`, cascade; `brand`, `hash`, `store_key`, `region_id`, `face_print` jsonb, `consent_at` nullable, `created_at`                                                                   | yes          |
| `calls`            | `id`                      | `caller_id`, `brand`, `kind`, `source_hash`, `request` jsonb, `framing` jsonb, `matches` jsonb, `redactions` jsonb, `steps` jsonb, `cost` jsonb, `error` jsonb, `status`, `started_at`, `duration_ms` | yes          |
| `outputs`          | `(brand, request_hash)`   | `store_key`, `call_id` → `calls`, `kind`, `placement`, `created_at`                                                                                                                                   | yes          |

Rules the table encodes:

- **Shapes another module owns are jsonb; what records filters or joins on is a column.** The Annotation is stored as contracts defines it and parsed with the contracts schema on read. `schema` and `produced_by` are also columns so the cache test `isComplete` and the re-annotate rule can be a query. Columns for Regions would be a second copy of a shape contracts owns, and every adapter change a migration.
- **jsonb is structurally equal, not byte-equal.** Postgres reorders object keys. Measured in the prototype: `isDeepStrictEqual` true, `JSON.stringify` equality false. "Stored verbatim" means the parsed value is identical; nothing may compare stored JSON as text.
- **No URL column anywhere.** `store.publicUrl(key)` is arithmetic (ADR-0010). A URL stored would have gone stale the day the stores moved region.
- **Every id records mints is `crypto.randomUUID()`** in a `text` column. A Person id lands in a Store Key and a UUID is path-safe. Brand ids are the slugs compose keys a Look on (`laica`, `hopefamily`, `swisshutless`), chosen by the seed.
- **`callers.key_hash` is the SHA-256 of the bearer key.** The key itself is never stored. `byKey` hashes and looks up; a Caller with a leaked table is a Caller with nothing leaked.
- **`identifications` does not exist.** [What belongs in an Annotation (#69)](https://github.com/timschoch/meco/issues/69) placed identification in records as a Brand-scoped cache. A Match is one 512-float dot product against a Brand's tens of prints, and identify has the Annotation in hand. The cache saved nothing measurable and needed an invalidation rule; this call's Matches live on the Call instead. Superseding decision on #76.

### The Call

One row per request that entered the gateway, `kind` one of `annotate | crop | render | carousel | enrol`. `request` is the wire request minus bytes: template, Placement, Fields and the FramingRequest as sent. `framing` is frame's Framing, `matches` identify's Matches, `redactions` redact's Redaction Records, each stored as its module defines it. `steps` is `[{ name, durMs }]`: the gateway's own timers plus every entry of models' `Server-Timing` header prefixed `models.`. "Which modules ran" is read off `steps`. `error` is `{ module, code, message }` and `status` is `ok | failed`; a failed Call is a row. `cost` is nullable jsonb whose shape the gateway defines when pricing arrives; records stores and returns it unread.

### Outputs, Request Hash and deletion

- `outputs` is keyed `(brand, request_hash)`, the key the Replay reads. `store_key` is a column, indexed with `brand`. One key holds a row per request that produced those bytes: two Brands whose Crops come out byte-identical are two rows on one key because no Brand appears in a public key (ADR-0010), and one Brand's bare Crop and the same Crop with `pinTo` spelled out to its default are two more ([#223](https://github.com/timschoch/meco/issues/223)).
- `outputs.record` is idempotent on `(brand, request_hash)` and answers the row already there. The gateway asks `byRequest` first, but two equal requests in flight at once both miss it, and the loser of that race must not be a `500` for a request that has an answer. It answers the row that is there even when the Store Key offered differs, so a non-deterministic second render under one Request Hash leaves bytes no row names; nothing reaches those, since the Sweep reads rows. Deterministic rendering is what keeps that unreachable, and it is a claim about compose, not about records.
- `requestHash(brand, kind, request)` is the SHA-256 of the canonical JSON of `{ brand, kind, request }` with object keys sorted at every depth. It lives in records so canonical means one thing. The gateway calls `outputs.byRequest` before running any module; a hit is an Output, and the gateway still records a Call whose only Step is `records.replay`.
- `outputs.delete(brand, storeKey)` deletes every row of that Brand on that key, counts the rows left on it, and calls `store.delete(key)` only at zero. The rows commit first and the bytes go after, as an Erasure does: the store is not in the transaction, so bytes deleted before a rollback would be bytes a surviving Output still names. The store stays unconditional (ADR-0010); the count is here. It answers `deleted` as well as `bytesDeleted`, because deleting an Output is what a caller retries after a timeout and "there was no such Output" and "the bytes stayed" are two different answers.
- The Gallery is `outputs.list({ brand?, placement?, kind?, callId?, limit, cursor? })`, newest first, keyset cursor over `(created_at, store_key, request_hash)` — the Request Hash is the tiebreak that makes the order total now that two of one Brand's Outputs may share a Store Key — each row joined with its Call's `source_hash`, `status` and `started_at`. `callId` is what the Call View lists one Call's Outputs with (decision on [#162](https://github.com/timschoch/meco/issues/162)). Offset pagination is out: the Gallery is append-only and keyset does not skip a row that landed mid-page. webui derives URLs; records returns Store Keys.

### Files, Source Holds and the Sweep

- `files.ensure` is idempotent on `hash`: the same photograph uploaded by two Brands is one row.
- `sources.hold(brand, hash)` is written when a Brand uploads or names a Source Image. `sources.heldBy(brand, hash)` is the lookup the gateway makes before minting a Signed URL for a source (decision on #86). One index hit; never a scan of `calls`, because a Call is also something a Brand may want deleted.
- `sources.release(brand, hash)` is the other end of a hold, and is idempotent for the reason `unenrol` and `erase` are: a caller retries after a timeout. It never touches the File — once the last hold is gone the photograph is the Sweep's, after the window. The immediate File cascade was sanctioned for erasing a Person and for nothing else (#76, Q11).
- The Reference Count of a File is its rows in `sources` plus `reference_photos`. `sweep(now)` deletes every File with a count of zero whose `first_seen_at` is older than the Retention Window, with its Annotation (cascade) and `store.delete` of its bytes, and reports what it removed. Default 30 days, `retentionDays` on `RecordsOptions`, read from `RECORDS_RETENTION_DAYS` by the gateway.
- **Never touches an Output**, and in two different senses. An Output is no reference to a File — `calls.source_hash` carries no foreign key on purpose, so an old Call can never block the Sweep — and the File of an Output's source goes like any other. But `store.delete` is unconditional (ADR-0010), so the Sweep counts the rows naming a Store Key before it deletes those bytes, and an `outputs` row naming that key keeps them. The Namespaces make the two key spaces disjoint today (`sources/` is private, `crops/` and `renders/` are public, and a key ends in the hash of its own bytes), so this guard holds an invariant rather than a reachable state; it is what makes "the Sweep never removes an Output's bytes" a claim a mutation can falsify rather than a restatement of the schema (#164).
- The Sweep has **no timer inside a container**, which sleeps. A Vercel cron calls the gateway's `GET /internal/sweep` behind `CRON_SECRET` at `0 4 * * *`, and the route answers the Sweep Report (decision on #164, superseding the boot timer on #86; the route is #187). `sweep()` takes `now` so a check can move the clock without touching `first_seen_at`, which the database sets and no seam method may.
- A stranger's Face Print lives inside the cached Annotation for exactly as long as some Brand holds the photograph. That is the answer to the retention question contracts left on #76.

### People, Reference Photos and Erasure

- A Reference Photo is a File like any other, so models annotates its bytes and the Annotation is cached under its hash, plus a `reference_photos` row that names the Person, the Region identify chose, the Face Print identify computed, and `consent_at`.
- `face_print` is a column on the row, not a pointer into the Annotation. The Annotation is shared bytes that a newer Model may re-annotate or the Sweep may remove; the print a Person was enrolled with is the Brand's own fact and stays beside the consent that allowed it.
- `consent_at` is set when the enroller says so and absent otherwise; records never fills it (ADR-0003, Decision 2).
- `people.erase(brand, id)` deletes the Person, its Reference Photo rows, and for each hash whose Reference Count reached zero the File and its Annotation, then `store.delete` on the keys, in one transaction around the rows and before the store calls. It returns the keys it deleted and the result of `store.list("people/<brand>/<id>")` afterwards, which must be empty.
- **Two kinds of key go, not one.** The Reference Photo keys are under `people/<brand>/<id>/`. A File whose Reference Count reached zero also has `files.store_key`, which for a photograph that was also a Source Image is `sources/<hash>.<ext>` and is not under that prefix — and once the row is gone the Sweep can never find those bytes again, because the Sweep reads rows. The Reference Count is what stops this reaching a source another Brand still holds.
- `people.unenrol(brand, photoId)` withdraws one Reference Photo from a Person who stays, by the same counting: the row goes with its Face Print, and the bytes go only once no row names the key. Two enrolments of the same file are two rows on one key, so deleting one photo does not delete the key while the other row stands. It leaves the **File** to the Sweep — the immediate File cascade was sanctioned for erasing a Person and for nothing else (#76, Q11), and withdrawing one photograph is not that. Not on the surface the grilling settled; the Erasure done-condition needs it and nothing else on `people` can delete one Reference Photo.
- Both are idempotent. A caller retries an Erasure after a timeout, and a second run that threw would make "delete this Person" a call nobody could safely repeat. `erased` and `deleted` say whether a row was there.
- `Erasure.remaining` is the store's own listing at the moment the bytes went, not an assertion records makes about itself. On a CDN-backed store it may still name a key for as long as that backend documents — Vercel Blob says up to 60 s — so a check against Blob polls to that deadline, as `@meco/store`'s own live checks do.
- `people.list(brand)` returns every Person with every Reference Photo's Face Print, in one read, because identify needs all of them per call.

### Brands and the seed

`pnpm records:seed` upserts the three Brands from a checked-in list and creates the first Caller from `MECO_BOOTSTRAP_KEY`, hashed. compose's Look ids and `brands.id` are the same strings: a Brand without a Look renders nothing, a Look without a Brand row owns nothing. Brands are not created over the API in v1.

The Seed is a function over a `Records` (`packages/records/seed.ts`) with a script around it, so the gate runs it twice against pglite and asserts what two runs leave. `brands.ensure` upserts, renaming a Brand but never re-dating it. `callers.create` takes no `on conflict`: one key is one Caller, and the unique index on `key_hash` refuses a second — the refusal is records' own message, because drizzle's wrapper prints the bound parameters and one of them is the key's SHA-256.

**The Seed converges.** It asks `callers.byKey` first; on a miss it creates the Caller with every seeded Brand, and on a hit it calls `callers.grant`, which is idempotent and additive. So the bootstrap Caller holds every Brand the checked-in list names after any run, a Brand added to the list later reaches the existing Caller on the next run, and a Brand granted by hand survives. A Seed that reported the gap instead would not be idempotent: the second run would not end where the first one would have. Nothing the Seed returns or prints carries the key or its hash; the script prints the host it connected to, and no credential.

### Configuration

| Variable                        | Sensitivity   | Purpose                                                     |
| ------------------------------- | ------------- | ----------------------------------------------------------- |
| `RECORDS_DATABASE_URL_UNPOOLED` | injected      | the pool's connection string; migrations use the same one   |
| `RECORDS_RETENTION_DAYS`        | non-sensitive | the Retention Window, default 30                            |
| `MECO_BOOTSTRAP_KEY`            | owner-set     | the first Caller's bearer key, read by the seed script only |
| `NEON_API_KEY`                  | owner-set     | lets the live suite create a throwaway branch; absent today |

The Neon connection is `meco-records-eu`, `eu-central-1`, Postgres 18.6 (measured 6 Sep 2026 with `select current_setting('server_version')`), database `neondb`, prefix `RECORDS_`. Vercel injects sixteen `RECORDS_*` variables; records reads one.

### Health

`reachRecords` runs `select version()` and counts migration files not present in drizzle's migrations table, timing the round trip. `pending > 0` on a running container is a bug the block shows, since boot applies migrations. The gateway adds the block to `GET /health` beside `store`, in the same shape.

The probe is **write-once**. `GET /health` is unauthenticated, so a probe that inserted on every call would be a write anybody could ask the primary database for. It reads the fixed-hash Annotation first and writes the File and the Annotation only when that read is a miss. `reachable` on the call that wrote is the round trip compared structurally against the constant; on every call after it is that a stored Annotation parsed and came back. Holding a row this build did not write against this build's constant would turn `/health` red the day the constant changed.

## Testing decisions

`recordsConformance(open, fixtures)` returns named Checks that both adapters run; a package's Vitest file maps them with `for (const c of checks) it(c.name, c.run)`. `open` returns a fresh, migrated `Records` per check.

| Check                                                                                                                                                  | Mutation that must turn it red                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `migrate` on an empty database creates every table; a second `migrate` applies nothing                                                                 | skip the migrations table lookup and re-run every file           |
| two `migrate` calls at once apply once                                                                                                                 | drop the advisory lock                                           |
| `annotations.put` then `get` is structurally equal and parses with the contracts schema                                                                | store `JSON.stringify` in a text column and compare as text      |
| `annotations.get` of an unknown hash is `null`, not a throw                                                                                            | throw on a miss                                                  |
| `files.ensure` twice on one hash is one row                                                                                                            | insert without `on conflict`                                     |
| `brands.ensure` twice on one id is one row under the last name                                                                                         | insert without `on conflict`                                     |
| `brands.get` of an id no Brand has is `null`, not a throw                                                                                              | throw on a miss                                                  |
| `callers.byKey` finds by hash and the table holds no plaintext key                                                                                     | store the key                                                    |
| `callers.byKey` of a key that created nothing is `null`, not a throw                                                                                   | throw on a miss                                                  |
| `callers.byKey` returns the Brands that Caller holds and no others                                                                                     | answer with every Brand row                                      |
| `callers.create` refuses a second Caller on one key, quoting neither the key nor its hash                                                              | let drizzle's wrapped error out                                  |
| `callers.grant` adds, never removes, and granting twice changes nothing                                                                                | replace the array instead of appending                           |
| the Seed twice leaves one row per Brand and one Caller                                                                                                 | insert the Brand instead of ensuring it                          |
| the Seed converges: a Caller short of a Brand holds it after the next run                                                                              | drop the grant and report the gap                                |
| the Seed refuses to run without a bootstrap key                                                                                                        | fall back to a constant key                                      |
| a second `/health` probe writes nothing                                                                                                                | write the probe on every call                                    |
| `sources.heldBy` is false for a Brand that never held the hash, true after `hold`, false after `release`, and answers from neither `files` nor `calls` | answer from `files` alone                                        |
| `sources.release` of a hold that is not there is not an error                                                                                          | throw on a hold that is not there                                |
| `outputs.delete` on a key two Brands share deletes one row and no bytes; the second delete removes the bytes                                           | call `store.delete` unconditionally                              |
| `outputs.byRequest` finds the Output of an equal request with keys in another order                                                                    | hash the request as given                                        |
| one Store Key holds a row per Request Hash: two requests, two Outputs, `byRequest` finds each, recording one twice answers the first, `delete` takes the bytes once | key `outputs` on `(brand, store_key)`                            |
| `outputs.list` is newest first, honours `placement` and `kind`, and a cursor never repeats or skips a row                                              | paginate by offset                                               |
| `calls.record` keeps a failed Call with its `error`                                                                                                    | refuse to insert when `status` is `failed`                       |
| `calls.record` fills nothing in: an `annotate` Call has no Framing, no Matches and no Steps                                                            | default the empty columns to a shape records invented            |
| `calls.record` refuses a `kind` or a `status` outside the closed set                                                                                   | accept any string                                                |
| `calls.list` is newest first, honours `status`, and its cursor never repeats or skips                                                                  | paginate by offset                                               |
| `requestHash` covers the Brand, the kind and array order                                                                                               | leave the Brand out of the hash                                  |
| `outputs.list` carries its Call's `source_hash`, `status` and `started_at`                                                                             | answer them off the Output's own row                             |
| `outputs.delete` of an Output that is not there is not an error and takes no bytes                                                                     | throw on an Output that is not there                             |
| `people.create` mints a UUID, and `people.get` finds the Person only for its own Brand                                                                 | look a Person up by id alone                                     |
| `people.enrol` without a File for the hash is refused                                                                                                  | write the File on the way in                                     |
| `people.enrol` keeps the Region and the print, and leaves `consent_at` absent when none was given                                                      | default `consent_at` to now                                      |
| `people.list` gives every Person of the Brand with every print, one with none included, and no other Brand's                                           | inner join; answer for every Brand                               |
| `people.erase` leaves no row, no Face Print and `store.list` of the prefix empty                                                                       | delete the Person and leave the Reference Photo rows             |
| `people.erase` on a Person with two enrolments of one file deletes the key once, and only after both rows are gone                                     | delete the key on the first row                                  |
| an Erasure never deletes a File another Brand holds as a Source Image, nor its bytes                                                                   | drop the `sources` half of the Reference Count                   |
| an Erasure never deletes a File another Brand has a Reference Photo of                                                                                 | drop the `reference_photos` half of the Reference Count          |
| `people.unenrol` deletes the last Reference Photo's bytes, keeps the Person, and leaves the File to the Sweep                                          | cascade the File as an Erasure does                              |
| `people.unenrol` and `people.erase` of something that is not there are not errors                                                                      | throw on a Person that is not there                              |
| `sweep` removes a File with no Source Hold older than the window, with its Annotation and bytes, and leaves a held one                                 | ignore `sources`                                                 |
| `sweep` leaves a File under a Reference Photo, and one younger than the window                                                                         | ignore `reference_photos`; compare `first_seen_at` the other way |
| `sweep` never removes an Output's bytes                                                                                                                | count `outputs` as zero references                               |
| the Retention Window is 30 days by default and is read from configuration                                                                              | compile the window in                                            |
| `reachRecords` reports `pending: 0` after `migrate` and a positive number before                                                                       | report zero always                                               |
| a driver failure on any statement binding a key hash or a Face Print reports neither                                                                   | rethrow the raw `DrizzleQueryError`                              |

`fixtures.withStore(store, retentionDays?)` takes the window as well as the store, because a window the checks could not change is a window they could not tell from a constant. Two things the Sweep's checks do that the others do not: they move the clock by handing `sweep` a `now` rather than by writing `first_seen_at`, which the database owns; and they assert on their own hashes and keys rather than on the whole report, because the live host runs every data check against one database and a Sweep there sees every other check's Files.

pglite runs the suite inside `pnpm check`, in the gate; measured start 966 ms on this laptop, so one pglite per suite file, one schema per check. The live suite `pnpm test:records:live` runs the identical checks against Neon and is named `*.live.ts` so Vitest's default glob cannot collect it, as store does. It runs on the main branch of `meco-records-eu` under a **run-scoped database** it drops. The throwaway branch this spec first named is not built: `NEON_API_KEY` is owner-set and has never been present, so the branch path would be a path nothing has run. It is a follow-up, and the day the key appears is the day to build it.

A database and not the run-scoped schema this spec first named: `drizzle-kit` writes every foreign key as `references "public"."files"(…)`, so tables created in a schema of one's own point their keys at `public` — at the deployment's rows. Measured 6 Sep 2026 against `meco-records-eu`: the whole People half of the list failed that way while passing on pglite, whose `public` was the run's own. A database has a `public` of its own, so the same SQL means what it says.

Two checks in that run are not in the conformance list, because what they prove is a call reaching a real store rather than a rule about rows: `erasure.live.ts` lists a Person's prefix before and after, and `sweep.live.ts` sweeps an unheld File and reads `store.head` of its Source Key back as `null` while a held one stands. Both drop their run-scoped database in `afterAll` and never in the check's own `finally` — `drop database … with (force)` terminates the connections it finds, and a pool still open comes back as an unhandled `57P01` that fails a run whose checks all passed.

Three checks take `fixtures.empty()` where the shape suggests `open()`, and all three for one reason: they are statements about a database nobody else has touched, and the live host gives every data check the same one. The two Seed checks migrate an empty database and seed that — a seeded database is exactly an empty one this check seeded itself, so no fixture beyond `empty()` is needed. The Bound Secret check wants the opposite and migrates nothing: a database with no tables makes every statement fail at the server, which is the cheapest honest driver failure there is, with no schema to damage and no shared pool to close.

The suite prints which path ran, which host it reached and what it cost. It reaches the host through `.env.local` parsed by `vitest.live.config.ts` rather than `process.loadEnvFile`, which never overrides a variable already exported in the shell — a stale export would otherwise silently point a suite that creates and drops databases at another one. Budget two minutes; measured 73 s for 56 checks against `ep-jolly-snow-b15wr267.c-5.eu-central-1.aws.neon.tech` from Zürich, 6 Sep 2026, on eight run-scoped databases.

Prior art: `packages/store/tests` for the two-adapter shape and the live config, `vitest.live.config.ts` for forwarding variables by name.

Every check is proved able to fail by the mutation beside it before it ships. Commit the green state first, then mutate, then `git restore`.

## Out of scope

- Pricing, quota, and the shape of `cost`. The column and the parameter are the hook.
- Accounts. `callers.brands` moves to an accounts table when accounts arrive (decision on [#77](https://github.com/timschoch/meco/issues/77)); Brand does not change.
- Creating Brands or Callers over the API. The seed is the only writer in v1.
- Preview-deployment Neon branches. Revisit when concurrent preview PRs collide (research, recommendation).
- Any read of bytes. records holds Store Keys; the store holds bytes.
- The Gallery's rendering. webui reads `outputs.list` and derives URLs.
- Human-drawn Regions, per-consumer models, an audit log beyond the Call.

## Further notes

`Content Hash`, `Annotation`, `Store Key`, `Brand`, `Person`, `Reference Photo` and `Face Print` are other modules' terms and are not redefined here. `Output` is the noun `CONTEXT.md` used informally as "stored output"; the records section makes it a term.

A retry that hits `outputs.byRequest` records a Call. The Gallery then shows one Output and two Calls, which is what happened.
