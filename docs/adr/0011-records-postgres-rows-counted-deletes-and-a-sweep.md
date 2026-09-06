# ADR-0011 — records keeps rows, not bytes: Neon Postgres over drizzle, verbatim Annotations, counted deletes and a Sweep

Status: **accepted, 6 Sep 2026**. Parent: [Module: records (#86)](https://github.com/timschoch/meco/issues/86), under the modular rebuild map [#60](https://github.com/timschoch/meco/issues/60). Settles [The records schema (#76)](https://github.com/timschoch/meco/issues/76). Spec: [`../specs/records.md`](../specs/records.md). Vocabulary: [`CONTEXT.md`, records](../../CONTEXT.md#records). Builds on [ADR-0003](0003-face-recognition-licence-consent-and-threshold.md) (a Person's deletion takes every Face Print with it), [ADR-0005](0005-contracts-annotation-framingrequest-and-zod.md) (the Annotation and its cache rule) and [ADR-0010](0010-store-vercel-blob-in-the-eu-two-stores.md) (`store.delete` is unconditional, URLs are arithmetic). Decided by the orchestrator with the records agent, the owner away; the grilling is ledgered on #76.

## Context

The prototype had no database. Records lived in the store as JSON blobs, the Gallery was `list("renders/")`, a Person was a prefix, and "which bytes are current" was an overwriting write. ADR-0010 removed the overwriting verb and said records is where mutability lives. Neon was chosen for records before this map ([#60](https://github.com/timschoch/meco/issues/60), settled outside), provisioned in `eu-central-1` ([#98](https://github.com/timschoch/meco/issues/98)), and stood empty: Postgres 18.6, zero tables, measured 6 Sep 2026.

Four questions were open and none of them is cheap to reverse once a row exists: how the schema reaches the database, what shape an Annotation has in it, who counts before a shared byte is deleted, and how long a stranger's Face Print lives.

## Decision 1 — drizzle over `pg`, SQL migrations committed, applied at boot under a lock

drizzle-orm over a plain `pg` `Pool` on `RECORDS_DATABASE_URL_UNPOOLED`. The container is a long-lived process with its own pool; PgBouncer's transaction mode would forbid the advisory lock this decision needs and buy nothing ([`../research/neon-on-vercel.md`](../research/neon-on-vercel.md)). `@neondatabase/serverless` is out because its pool may not outlive one request.

Schema in TypeScript, `drizzle-kit generate` SQL committed, `migrate()` at gateway boot inside `pg_advisory_lock`. `push` leaves no history; a CI migration job is a second pipeline that Vercel's push-to-promote gives us no hook to sequence against. The image and the schema it needs land together or the boot fails, loudly.

Measured 6 Sep 2026 in `.temp/records-proto` (drizzle-orm 0.45.2, drizzle-kit 0.31.10, pg 8.23.0, pglite 0.5.8, Node 26.7, this laptop): drizzle's migrator runs unchanged on pglite, first migrate 48 ms, second 2 ms, pglite start 966 ms; `pg.Pool` to Neon from Zürich 583 ms cold, 57 ms warm.

## Decision 2 — the Annotation is one jsonb column, and jsonb is not text

The contracts Annotation is stored whole in `annotations.annotation`, parsed with the contracts zod schema on read, with `schema` and `produced_by` duplicated as columns so `isComplete` and the re-annotate rule are queries. Columns for Regions would copy a shape contracts owns and turn every adapter change into a migration. Postgres reorders jsonb keys, so the stored value is structurally equal to what was written and never byte-equal; the prototype measured `isDeepStrictEqual` true and `JSON.stringify` equality false. No code may compare stored JSON as text.

`identifications`, the Brand-scoped cache [#69](https://github.com/timschoch/meco/issues/69) placed in records, is not built. A Match is one dot product of a 512-float print against a Brand's tens of prints; the cache saved nothing measurable and needed an invalidation rule that had to be right. This call's Matches live on the Call.

## Decision 3 — records counts, the store deletes

`outputs` is keyed `(brand, store_key)`. Two Brands with byte-identical Crops are two rows on one public key, because ADR-0010 keeps the Brand out of public keys. `outputs.delete` removes the row and calls `store.delete` only when no row is left on that key, in one transaction. The alternative, never deleting bytes, would make "delete my Crop" a sentence meco cannot say honestly. The same count guards a Person's two enrolments of one file.

Source Images are shared private bytes, so who may see one is not in the key. A `sources (brand, hash)` row, the Source Hold, is the fact the gateway checks before minting a Signed URL. It is its own table and not a scan of `calls`, because a Call is also a thing a Brand may delete.

## Decision 4 — a stranger's Face Print lives as long as the photograph is held, then the Sweep removes it

The Face Print stays inside the cached Annotation (ADR-0005 keeps it there because it is true of the bytes). Its retention is the File's: a File with no Source Hold and no Reference Photo for longer than the Retention Window, 30 days by default and a configuration value, is removed by the Sweep with its Annotation and its bytes. Deleting a Person does not wait for the Sweep: `people.erase` removes the Reference Photo rows, the Face Prints, the Files whose count reached zero, and every byte under the Person's prefix, and returns the empty listing as proof, because ADR-0003 promised that and a test has to be able to fail on it.

Rejected: stripping the print before storing and re-embedding on every miss. It costs an EdgeFace run per Crop and makes "cached forever" false for the one field identify needs.

## Decision 5 — two adapters, pglite in the gate

The suite runs on pglite in `pnpm check` and, identically, on Neon under `pnpm test:records:live`, a throwaway branch when `NEON_API_KEY` is present and a run-scoped schema on the main branch otherwise. pglite is real Postgres in-process, so the committed SQL, jsonb, arrays and the migrator are exercised as written with no network. Testcontainers was rejected for needing Docker on every runner; Neon-only for putting `fra1` on the path of every test.

## Consequences

- records is the only module with a `Store` and a `Database` in hand, so every cascade and the Sweep are records methods and no other module can delete a byte by accident.
- A retry is a `records` lookup by Request Hash and one Call whose only Step is `records.replay`; the Gallery shows one Output and two Calls.
- `pending > 0` in the `/health` records block on a running container is a bug, since boot applies migrations.
- The Retention Window is a data-protection decision the owner can change without a deploy. Thirty days is a default with no measurement behind it; the owner sets the number.
- The prototype's `.env.local` in a developer clone still names the deleted `us-east-1` project; `vercel env pull` refreshes it.
