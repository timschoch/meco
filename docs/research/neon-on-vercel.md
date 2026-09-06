# Neon on Vercel for `records`

Scope: pooled-vs-direct connections, Marketplace env-var injection, preview branching, migration tooling, and scale-to-zero cold start — for a long-lived container process (not Fluid Compute) using Neon via the Vercel Marketplace. Feeds ticket #72 (Neon provisioning).

## 1. Pooled vs direct connection

Neon gives two connection strings per database/branch: pooled (hostname carries `-pooler`, routes through PgBouncer) and direct/unpooled (no `-pooler`).

- Pooled: "Use the pooled connection string (hostname with -pooler suffix) for serverless functions and connection-per-request workloads." Source: https://neon.com/docs/connect/connection-pooling
- Direct: "Use a direct connection for schema migrations, pg_dump, logical replication, and queries that depend on SET, LISTEN/NOTIFY, or session-level state." Source: https://neon.com/docs/connect/connection-pooling
- Neon runs PgBouncer in **transaction mode** (`pool_mode=transaction`): "connections are returned to the pool after each transaction completes." Unsupported under transaction mode: `SET`/`RESET` (session variables), `LISTEN`/`NOTIFY`, `WITH HOLD CURSOR`, `PREPARE`/`DEALLOCATE` (SQL-level prepared statements). Source: https://neon.com/docs/connect/connection-pooling

**Why serverless needs pooling**: each invocation tends to open its own connection; without pooling this exhausts Postgres's connection limit quickly. PgBouncer multiplexes many client connections onto few backend connections. Source: https://neon.com/docs/connect/connection-pooling

**Long-lived process with its own pool (this is `records`'s case)**: a persistent process holding a `pg`/`postgres.js` pool does not have the per-invocation connection-storm problem serverless has — it opens a small, stable number of backend connections and reuses them. Neon's own guidance table (bundled in the local `neon-postgres` skill, sourced from Neon's connection-pooling doc) puts "Web applications, serverless functions" under pooled, and "Schema migrations", "pg_dump/pg_restore", "Logical replication", "Long-running analytics with temp tables", "Admin tasks needing SET or session state", "LISTEN/NOTIFY" under direct. A long-lived pooled process sits in neither row explicitly, but the reasoning applies directly: it doesn't need PgBouncer's connection-multiplexing (it isn't opening one connection per request), and by going direct it avoids the transaction-mode restrictions (no `SET`, `LISTEN/NOTIFY`, prepared statements) that would otherwise limit what the app-level pool can do with a session. Source: https://neon.com/docs/connect/connection-pooling (table content mirrored in local skill `neon-postgres`, `.claude/skills/neon-postgres/SKILL.md`).

Caveat: Neon's docs don't give a single explicit sentence saying "long-lived pooled processes should use the direct string" — this is the documented tradeoff table applied to the `records` case, not a verbatim quote for that exact scenario. Flagging this as inferred-from-documented-tradeoffs, not a direct citation.

## 2. What the Neon-on-Vercel Marketplace integration injects

Two distinct integration types exist:

- **Vercel-Managed (Native) Integration** — billing through Vercel, or link to an existing Neon account. Source: https://vercel.com/marketplace/neon
- **Neon-Managed Integration** — Neon account is the source of truth; adds Preview Branching. Source: https://neon.com/docs/guides/vercel-native-integration (references Neon-Managed docs at https://neon.com/docs/guides/neon-managed-vercel-integration)

**Env vars created** (native integration), per https://neon.com/docs/guides/vercel-native-integration:
`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `PGHOST`, `PGHOST_UNPOOLED`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`, `POSTGRES_*` (legacy), `NEON_AUTH_BASE_URL`, `VITE_NEON_AUTH_URL`.

**Prefix customization**: supported. "You can add a prefix if you have multiple databases in the same project, for example `PRIMARY_`." Source: https://neon.com/docs/guides/vercel-native-integration

This means the prefix is applied to the whole injected set (e.g. `PRIMARY_DATABASE_URL`, `PRIMARY_DATABASE_URL_UNPOOLED`, ...) — not a rename of individual variables to an arbitrary name. There is no documented way to get exactly `RECORDS_DATABASE_URL` as a bespoke single name unless `RECORDS_` is used as that prefix (giving `RECORDS_DATABASE_URL`, `RECORDS_DATABASE_URL_UNPOOLED`, etc. — the rest of the `RECORDS_` set comes along with it).

**Target environments**: not defaulted. When connecting the database to a Vercel project you "choose the Vercel project and the environments that should receive database variables (Development, Preview, Production)" — this is an explicit selection step, not a preset. Source: https://neon.com/docs/guides/vercel-native-integration

General Vercel behavior backing this: env vars are scoped per Environment (Production / Preview / Development / custom), and "Integrations can automatically add environment variables to your Project Settings" — shown attributed to the integration in Project Settings once added. Source: https://vercel.com/docs/environment-variables

Could not verify from a primary source: an explicit Vercel mechanism to _rename_ an integration-injected variable after the fact (as opposed to setting a prefix at connect time). The general env-vars doc (https://vercel.com/docs/environment-variables) describes creation/scoping but documents no rename/alias feature for integration-managed variables. Treat "rename after injection" as unconfirmed — the documented lever is the connect-time prefix only.

## 3. Branch-per-preview-deployment

Supported, but the exact wiring differs between the two integration types, and only one primary source describes the mechanism precisely:

- **Neon-Managed Integration**: branch scope is **per git branch**, not per individual deployment. "The integration receives a webhook from Vercel and creates a new Neon branch named `preview/<git-branch>`." Flow: push to a feature branch → "Vercel triggers a preview deployment" → the Neon-side integration (webhook-driven) creates/reuses the branch for that git branch. Automatic cleanup is available and recommended: it "remove[s] preview branches automatically when the corresponding Git branch is deleted." Source: https://neon.com/docs/guides/vercel-previews-integration
- **Vercel-Managed (Native) Integration**: the marketplace overview states both integration paths "auto-provision Lakebase Postgres database branches for Vercel preview deployments," and separately describes the Neon-Managed path's Preview Branching as "Automatic (Git-branch-based)" cleanup. Source: https://vercel.com/marketplace/neon

**Cost, limits, plan tier**: not documented on the branching/previews integration pages themselves. Source: https://neon.com/docs/guides/vercel-previews-integration and https://neon.com/docs/introduction/branching (neither states per-branch creation cost or plan gating for the _preview integration_ specifically).

Pulled from Neon's plans page instead (https://neon.com/docs/introduction/plans — general branch limits, not preview-integration-specific):

- Free: 10 branches/project, no paid overage (capped at 10).
- Launch: 10 branches/project included; extra branches at $1.50/branch-month.
- Scale: 25 branches/project included; extra branches at $1.50/branch-month.
- Branch creation itself (the copy-on-write operation) is not separately priced beyond the branch-slot cost above — compute and storage for that branch's usage bill normally. Source: https://neon.com/docs/introduction/plans

History-window retention referenced alongside branching: "Neon retains a history of changes for your branches, with defaults of 6 hours on Free plan and 1 day on paid plans." Source: https://neon.com/docs/introduction/branching

**Not verifiable from primary sources in this pass**: an explicit statement that the Vercel preview-branching integration requires a specific paid Neon plan tier (e.g. "Preview Branching requires Launch or above"). Flagging this as unconfirmed — plan-gating for the _integration feature itself_ (as opposed to general branch-count limits) was not found on the pages fetched.

## 4. Migration tooling

**Drizzle-kit's own stance** (general, not Neon-specific): `push` is explicitly positioned for prototyping: "That's the best approach for rapid prototyping and we've seen dozens of teams and solo developers successfully using it as a primary migrations flow in their production applications." Source: https://orm.drizzle.team/docs/migrations

Drizzle frames `generate` + `migrate` as the SQL-file-based, version-controlled alternative for team collaboration, vs. `push`'s direct schema-diff-and-apply with no SQL files. It does not gate the choice by data-maturity stage — it says pick "SQL migration flow that suits your business needs best." Source: https://orm.drizzle.team/docs/kit-overview

**Neon's own Drizzle guide diverges**: it documents the `generate` + `migrate` workflow (generate SQL files, then run them via Drizzle's `migrate()` function against the database) and does not mention `push` or raw SQL as options. Source: https://neon.com/docs/guides/drizzle-migrations

**Connection type for migrations, Neon-specific**: direct/unpooled, explicitly: "using a pooled connection string for migrations can lead to errors. For this reason, we recommend using a direct (non-pooled) connection when performing migrations." Source: https://neon.com/docs/guides/drizzle-migrations (consistent with the general pooling guide, section 1 above)

**Driver for Drizzle+Neon**: "Drizzle has native support for Neon connections with the `neon-http` and `neon-websockets` drivers." HTTP driver is positioned as "faster for single, non-interactive transactions"; WebSocket driver is for when "you need session or interactive transaction support." Source: Drizzle Neon getting-started guide, https://orm.drizzle.team/docs/get-started/neon-new — note this guide targets Neon's serverless drivers, not `pg`/`postgres.js` against a long-lived container process; see Recommendation section below for why `records` should not follow this specific driver pick.

## 5. Scale-to-zero cold start

- Default suspend timeout: "When your database is inactive, it automatically scales to zero after 5 minutes." Source: https://neon.com/docs/introduction/scale-to-zero
- Resume/cold-start latency: "Once you query the database again, it reactivates automatically within a few hundred milliseconds." Source: https://neon.com/docs/introduction/scale-to-zero
- No more precise number (e.g. p50/p95 in ms) is given on that page — "a few hundred milliseconds" is the exact documented granularity.
- Plan-level control over suspend timeout / disabling scale-to-zero: Free plan cannot disable it (fixed 5 min); Launch and Scale can configure or disable it, Scale down to "1 minute to always on." Source: https://neon.com/docs/introduction/plans

## Recommendation for meco

**Driver**: use `pg` (node-postgres) with a standard `Pool`, not `@neondatabase/serverless`. Reason: `records` is an explicitly long-lived container process, and `@neondatabase/serverless`'s `Pool`/`Client` over WebSocket "can't outlive a single request" — "`Pool` or `Client` objects must be connected, used and closed within a single request handler" (source: https://github.com/neondatabase/serverless README). That constraint is designed for one-shot serverless/edge invocations, the opposite of `records`'s runtime model. `pg` against Postgres wire protocol has no such lifetime restriction and is the documented pairing for regular Node processes holding their own pool.

**Connection string**: use the **direct (unpooled)** connection string (`DATABASE_URL_UNPOOLED` as injected, or `PRIMARY_DATABASE_URL_UNPOOLED` if a prefix is used) for the app's own `pg.Pool`, and reserve the pooled string only for anything Neon or Drizzle explicitly say needs PgBouncer transaction-mode behavior (nothing in `records`'s design currently does). Reason: `records` holds its own pool, so PgBouncer's connection-multiplexing buys nothing, while going through PgBouncer's transaction mode would forbid `SET`, `LISTEN/NOTIFY`, and prepared statements if `records` ever needs them (source: https://neon.com/docs/connect/connection-pooling). Migrations must use the direct string regardless — that part is unambiguous and Neon-documented (https://neon.com/docs/guides/drizzle-migrations).

**Env var naming**: the Neon-on-Vercel integration lets you set a connect-time prefix (documented example: `PRIMARY_`) that prefixes the _entire_ injected variable set — there is no way to get a single bespoke name like `RECORDS_DATABASE_URL` without the rest of the `RECORDS_*` set coming along (`RECORDS_DATABASE_URL_UNPOOLED`, `RECORDS_PGHOST`, etc.). For ticket #72: when linking the Neon database to the Vercel project, set the prefix to `RECORDS_`, so the app reads `RECORDS_DATABASE_URL_UNPOOLED` for its pool. Do not rely on a post-injection rename feature — none is documented (checked https://vercel.com/docs/environment-variables). Select **Production only** at link time; add Preview explicitly only once the preview-branch decision below is revisited.

**Preview-branch wiring: no, not now.** Reason: the mechanism is real and well-documented (webhook-driven, per-git-branch Neon branches via the Neon-Managed integration, https://neon.com/docs/guides/vercel-previews-integration), but two things are unresolved from primary sources — whether it needs a paid Neon plan tier beyond Free, and its branch-count interaction with the 10-branches-on-Free cap. `records` has no production users yet and a small, fast-iterating schema; the value of per-preview isolated data is low right now, and wiring cost (installing the Neon-Managed integration, webhook config, cleanup policy) isn't justified before the schema and container setup exist at all. Revisit once `records` has a stable schema and multiple concurrent preview PRs actually collide over shared dev-branch state.

**Migration tool: drizzle-kit, `generate` + `migrate` (not `push`).** Reason: Neon's own Drizzle guide documents `generate`+`migrate` for Neon and doesn't mention `push` (https://neon.com/docs/guides/drizzle-migrations). Drizzle's own docs say `push` is fine for prototyping and even some production teams (https://orm.drizzle.team/docs/migrations), so either would be defensible given no production data yet — but `generate`+`migrate` costs nothing extra (schema is small) and leaves a SQL migration history from day one instead of retrofitting one later when `records` does get users. Run migrations over the direct connection string, per Neon's explicit instruction (https://neon.com/docs/guides/drizzle-migrations).

**Provisioning steps for ticket #72**:

1. Create (or select) the Neon project for `records` via the Neon Console or `neon projects create --name records`.
2. Install the Neon Marketplace integration on the Vercel project (Vercel-Managed/Native path is sufficient — Neon-Managed only needed if/when preview branching is adopted): https://vercel.com/marketplace/neon → "Link Existing Neon Account" (or create-new) → connect the `records` Neon project.
3. At the connect step, set variable prefix to `RECORDS_` and select environment scope = Production (per the recommendation above). This yields `RECORDS_DATABASE_URL`, `RECORDS_DATABASE_URL_UNPOOLED`, `RECORDS_PGHOST`, `RECORDS_PGHOST_UNPOOLED`, `RECORDS_PGUSER`, `RECORDS_PGDATABASE`, `RECORDS_PGPASSWORD` (source for the variable set: https://neon.com/docs/guides/vercel-native-integration).
4. In `records`, configure the app's `pg.Pool` to read `RECORDS_DATABASE_URL_UNPOOLED`.
5. Add `drizzle-kit` (`drizzle.config.ts` pointing at `RECORDS_DATABASE_URL_UNPOOLED`), write the schema, run `drizzle-kit generate` then `drizzle-kit migrate` for the first migration.
6. Pull vars locally with `vercel env pull` (or `neon env pull` — either documented) rather than hand-copying secrets.

### Not verified against a primary source (flagged explicitly)

- Whether the Vercel preview-branching integration (either Native or Neon-Managed) requires a specific paid Neon plan tier beyond Free — not stated on https://neon.com/docs/guides/vercel-previews-integration or https://vercel.com/marketplace/neon.
- Whether branch creation via the Vercel preview integration is billed any differently from a manually created branch — not stated on the pages checked; general branch-slot/overage pricing from https://neon.com/docs/introduction/plans is the closest documented number.
- Any Vercel-native mechanism to rename an integration-injected env var after creation (as distinct from setting a prefix at connect time) — not found in https://vercel.com/docs/environment-variables.
- A single sentence in Neon's docs naming "a long-lived process with its own pool" as a direct-connection use case verbatim — this is derived from the documented pooled-vs-direct tradeoffs (section 1), not a direct quote for that exact phrase.
