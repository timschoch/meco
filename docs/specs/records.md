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
      limit: number;
      cursor?: string;
    }): Promise<Page<Call>>;
  };
  outputs: {
    record(output: NewOutput): Promise<Output>;
    byRequest(brand: string, requestHash: string): Promise<Output | null>;
    list(query: OutputQuery): Promise<Page<Output>>; // the Gallery
    delete(brand: string, storeKey: string): Promise<{ bytesDeleted: boolean }>;
  };
  requestHash(brand: string, kind: CallKind, request: unknown): string;
  sweep(now?: Date): Promise<SweepReport>;
  close(): Promise<void>;
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
| `outputs`          | `(brand, store_key)`      | `call_id` → `calls`, `kind`, `placement`, `request_hash`, `created_at`                                                                                                                                | yes          |

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

- `outputs` is keyed `(brand, store_key)`. Two Brands whose Crops come out byte-identical are two rows on one key, and no Brand appears in a public key (ADR-0010).
- `requestHash(brand, kind, request)` is the SHA-256 of the canonical JSON of `{ brand, kind, request }` with object keys sorted at every depth. It lives in records so canonical means one thing. The gateway calls `outputs.byRequest` before running any module; a hit is an Output, and the gateway still records a Call whose only Step is `records.replay`.
- `outputs.delete(brand, storeKey)` deletes the row, counts the rows left on that key, and calls `store.delete(key)` only at zero, all in one transaction. The store stays unconditional (ADR-0010); the count is here.
- The Gallery is `outputs.list({ brand?, placement?, kind?, limit, cursor? })`, newest first, keyset cursor over `(created_at, store_key)`, each row joined with its Call's `source_hash`, `status` and `started_at`. Offset pagination is out: the Gallery is append-only and keyset does not skip a row that landed mid-page. webui derives URLs; records returns Store Keys.

### Files, Source Holds and the Sweep

- `files.ensure` is idempotent on `hash`: the same photograph uploaded by two Brands is one row.
- `sources.hold(brand, hash)` is written when a Brand uploads or names a Source Image. `sources.heldBy(brand, hash)` is the lookup the gateway makes before minting a Signed URL for a source (decision on #86). One index hit; never a scan of `calls`, because a Call is also something a Brand may want deleted.
- The Reference Count of a File is its rows in `sources` plus `reference_photos`. `sweep(now)` deletes every File with a count of zero whose `first_seen_at` is older than the Retention Window, with its Annotation (cascade) and `store.delete` of its bytes, and reports what it removed. Default 30 days, `retentionDays` on `RecordsOptions`, read from `RECORDS_RETENTION_DAYS` by the gateway. Never touches an Output.
- A stranger's Face Print lives inside the cached Annotation for exactly as long as some Brand holds the photograph. That is the answer to the retention question contracts left on #76.

### People, Reference Photos and Erasure

- A Reference Photo is a File like any other, so models annotates its bytes and the Annotation is cached under its hash, plus a `reference_photos` row that names the Person, the Region identify chose, the Face Print identify computed, and `consent_at`.
- `face_print` is a column on the row, not a pointer into the Annotation. The Annotation is shared bytes that a newer Model may re-annotate or the Sweep may remove; the print a Person was enrolled with is the Brand's own fact and stays beside the consent that allowed it.
- `consent_at` is set when the enroller says so and absent otherwise; records never fills it (ADR-0003, Decision 2).
- `people.erase(brand, id)` deletes the Person, its Reference Photo rows, and for each hash whose Reference Count reached zero the File and its Annotation, then `store.delete` on the keys, in one transaction around the rows and before the store calls. It returns the keys it deleted and the result of `store.list("people/<brand>/<id>")` afterwards, which must be empty.
- **Two kinds of key go, not one.** The Reference Photo keys are under `people/<brand>/<id>/`. A File whose Reference Count reached zero also has `files.store_key`, which for a photograph that was also a Source Image is `sources/<hash>.<ext>` and is not under that prefix — and once the row is gone the Sweep can never find those bytes again, because the Sweep reads rows. The Reference Count is what stops this reaching a source another Brand still holds.
- `people.unenrol(brand, photoId)` withdraws one Reference Photo from a Person who stays, by the same counting: the row goes, and the bytes go only once no row names the key. Two enrolments of the same file are two rows on one key, so deleting one photo does not delete the key while the other row stands. Not on the surface the grilling settled; the Erasure done-condition needs it and nothing else on `people` can delete one Reference Photo.
- Both are idempotent. A caller retries an Erasure after a timeout, and a second run that threw would make "delete this Person" a call nobody could safely repeat. `erased` and `deleted` say whether a row was there.
- `Erasure.remaining` is the store's own listing at the moment the bytes went, not an assertion records makes about itself. On a CDN-backed store it may still name a key for as long as that backend documents — Vercel Blob says up to 60 s — so a check against Blob polls to that deadline, as `@meco/store`'s own live checks do.
- `people.list(brand)` returns every Person with every Reference Photo's Face Print, in one read, because identify needs all of them per call.

### Brands and the seed

`pnpm records:seed` upserts the three Brands from a checked-in list and creates the first Caller from `MECO_BOOTSTRAP_KEY`, hashed. compose's Look ids and `brands.id` are the same strings: a Brand without a Look renders nothing, a Look without a Brand row owns nothing. Brands are not created over the API in v1.

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

## Testing decisions

`recordsConformance(open, fixtures)` returns named Checks that both adapters run; a package's Vitest file maps them with `for (const c of checks) it(c.name, c.run)`. `open` returns a fresh, migrated `Records` per check.

| Check                                                                                                                  | Mutation that must turn it red                              |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `migrate` on an empty database creates every table; a second `migrate` applies nothing                                 | skip the migrations table lookup and re-run every file      |
| two `migrate` calls at once apply once                                                                                 | drop the advisory lock                                      |
| `annotations.put` then `get` is structurally equal and parses with the contracts schema                                | store `JSON.stringify` in a text column and compare as text |
| `annotations.get` of an unknown hash is `null`, not a throw                                                            | throw on a miss                                             |
| `files.ensure` twice on one hash is one row                                                                            | insert without `on conflict`                                |
| `callers.byKey` finds by hash and the table holds no plaintext key                                                     | store the key                                               |
| `sources.heldBy` is false for a Brand that never held the hash, true after `hold`, false after `release`               | answer from `files` alone                                   |
| `outputs.delete` on a key two Brands share deletes one row and no bytes; the second delete removes the bytes           | call `store.delete` unconditionally                         |
| `outputs.byRequest` finds the Output of an equal request with keys in another order                                    | hash the request as given                                   |
| `outputs.list` is newest first, honours `placement` and `kind`, and a cursor never repeats or skips a row              | paginate by offset                                          |
| `calls.record` keeps a failed Call with its `error`                                                                    | refuse to insert when `status` is `failed`                  |
| `people.create` mints a UUID, and `people.get` finds the Person only for its own Brand                                 | look a Person up by id alone                                |
| `people.enrol` without a File for the hash is refused                                                                  | write the File on the way in                                |
| `people.enrol` keeps the Region and the print, and leaves `consent_at` absent when none was given                      | default `consent_at` to now                                 |
| `people.list` gives every Person of the Brand with every print, one with none included, and no other Brand's           | inner join; answer for every Brand                          |
| `people.erase` leaves no row, no Face Print and `store.list` of the prefix empty                                       | delete the Person and leave the Reference Photo rows        |
| `people.erase` on a Person with two enrolments of one file deletes the key once, and only after both rows are gone     | delete the key on the first row                             |
| an Erasure never deletes a File another Brand holds as a Source Image, nor its bytes                                   | drop the `sources` half of the Reference Count              |
| an Erasure never deletes a File another Brand has a Reference Photo of                                                 | drop the `reference_photos` half of the Reference Count     |
| `people.unenrol` deletes the bytes and the File of the last Reference Photo naming them, and leaves the Person         | leave an orphaned File to the Sweep                         |
| `people.unenrol` and `people.erase` of something that is not there are not errors                                      | throw on a Person that is not there                         |
| `sweep` removes a File with no Source Hold older than the window, with its Annotation and bytes, and leaves a held one | ignore `sources`                                            |
| `sweep` never removes an Output's bytes                                                                                | count `outputs` as zero references                          |
| `reachRecords` reports `pending: 0` after `migrate` and a positive number before                                       | report zero always                                          |

pglite runs the suite inside `pnpm check`, in the gate; measured start 966 ms on this laptop, so one pglite per suite file, one schema per check. The live suite `pnpm test:records:live` runs the identical checks against Neon and is named `*.live.ts` so Vitest's default glob cannot collect it, as store does. With `NEON_API_KEY` present it creates a throwaway branch of `meco-records-eu` and deletes it in `finally`; without, it runs on the main branch under a **run-scoped database** it drops.

A database and not the run-scoped schema this spec first named: `drizzle-kit` writes every foreign key as `references "public"."files"(…)`, so tables created in a schema of one's own point their keys at `public` — at the deployment's rows. Measured 6 Sep 2026 against `meco-records-eu`: the whole People half of the list failed that way while passing on pglite, whose `public` was the run's own. A database has a `public` of its own, so the same SQL means what it says.

The suite prints which path ran, which host it reached and what it cost. It reaches the host through `.env.local` parsed by `vitest.live.config.ts` rather than `process.loadEnvFile`, which never overrides a variable already exported in the shell — a stale export would otherwise silently point a suite that creates and drops databases at another one. Budget two minutes; measured 32 s for 24 checks from Zürich, 6 Sep 2026.

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
