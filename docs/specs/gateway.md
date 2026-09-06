# Spec: the gateway module

Parent: [Module: gateway (#88)](https://github.com/timschoch/meco/issues/88). Reasons: [ADR-0014](../adr/0014-gateway-one-operation-table-two-doors.md). Vocabulary: [`CONTEXT.md`, gateway](../../CONTEXT.md#gateway). Neighbours: every other spec in this folder; the gateway is their only common caller. Deploy shape: [`DEPLOY.md`](../../DEPLOY.md). Package layout: [`packages/README.md`](../../packages/README.md).

## Problem statement

Eight modules each do one thing well and none of them can be called from outside. A caller with a photograph and a Brand has to reach a store, a database, a model container, an identifier, a solver, a redactor and a renderer, in the right order, with the right Brand, and be refused when the Brand is not theirs. Two kinds of caller exist, an HTTP client and an MCP agent, and if each door is written by hand they drift apart, as the prototype's did.

## Solution

One package, `@meco/gateway`, one Hono app. It holds the Caller lookup, the Brand Wall, an Operation table that both Doors are generated from, the pipeline that runs the modules in order for each Call kind, the Call record, `/health`, the Sweep's cron route and the mount for the webui. It owns no rows, no model and no pixel arithmetic beyond one decode.

## User stories

1. As an HTTP client, I want to `POST` a photograph's URL, a Template, a Placement and Fields and get a Render's URL back, so that one call gives me a finished social image.
2. As an HTTP client, I want to `POST` a photograph's URL and a size and get a Crop's URL back, so that I get a subject-aware cut with no Template.
3. As an MCP agent, I want the same verbs as tools with schemas I can read in `tools/list`, so that I fill a request unaided and get the same answer an HTTP client would.
4. As an MCP agent, I want to ask who is in a photograph before I render, so that I choose the Template and the pin knowing what meco sees.
5. As an MCP agent, I want a tool result to carry the URL and the reasons, never the bytes, so that my context is not filled with an image.
6. As a caller, I want one key that opens the HTTP door, the MCP door and the webui, so that I hold one secret.
7. As a caller, I want a Brand I do not hold refused with one code on every door, before anything runs, so that I learn the wall once and it costs me nothing.
8. As a caller holding several Brands, I want list routes to show every Brand of mine when I name none, so that one key serves three Brands from one client.
9. As a caller, I want the same request twice to give the same URL without a second render, so that a retry is free and a duplicate post is impossible.
10. As a caller, I want a photograph I already sent to be nameable by its Content Hash, so that a second output of it uploads nothing.
11. As a caller, I want every face in the answer explained: named, unknown, uncompared, hidden, kept in frame, so that I know what the picture shows before I publish it.
12. As a caller, I want strangers blurred unless I say otherwise, so that the safe answer is the default one.
13. As a caller, I want to enrol a Person from a photograph with a consent date and erase them later, so that the Brand's People are mine to manage over the API.
14. As a caller, I want a wrong input refused with a code and the field that failed, so that I fix the request and not my reading of the docs.
15. As the owner, I want every request recorded as a Call with its Steps, its request and what each module answered, so that the webui explains what happened and a failure is a row.
16. As the owner, I want a Face Print never to leave the deployment over the API, so that a biometric template is not in any response body.
17. As the owner, I want `/health` to say whether models, both stores and the database are reachable and whether models is warm, without costing a Blob and a Neon round trip per poll.
18. As the owner, I want the Sweep to run when nobody is calling, so that a stranger's Face Print does not outlive the Retention Window because the container was asleep.
19. As the owner, I want the first Caller to exist from a key I set, so that the first call can happen before the first row.
20. As a developer, I want the whole suite to run through the app with real modules on pglite and the in-memory store, so that a gateway test never reaches Neon, Blob or a model.
21. As a developer, I want a probe script that runs the tracer bullet against any deployment, so that every ticket is proved against the running system.
22. As the orchestrator, I want an MCP client in a separate repository to call the live gateway end to end, so that the door is proven for a client that shares none of our code.
23. As a future pricing author, I want the Caller on the request context and `cost` on the Call, so that quota and pricing land at the door without a redesign.

## Implementation decisions

### The exported surface

```ts
// packages/gateway/app.ts — the HTTP surface, both Doors, no socket
export function createApp(deps: GatewayDeps): Hono;

export interface GatewayDeps {
  records: Records; // @meco/records
  store: Store; // @meco/store
  models: ModelsClient; // @meco/models (index.ts, the thin client)
  fetch?: typeof fetch; // fetches a Source Reference's URL; default globalThis.fetch
  cronSecret?: string; // CRON_SECRET; absent means /internal/* answers 404
  version?: string; // reported by /health
  now?: () => Date; // Calls' started_at and the Sweep; default Date
}

export type { Health, ModelsReach } from "./lib/health";
export type { StoreHealth, StoreReach } from "@meco/store/health";

// packages/gateway/server.ts — the process: env → deps, migrate, listen
```

One factory, one seam. `createApp` receives every adapter that varies (records, store, the models client, the clock, the fetch) and builds the pure modules (identify from records + store + the models client; compose, frame and redact have no state) itself. Everything under `lib/` is private: the Operation table, the Doors, auth, the Brand Wall, the pipeline, the Call assembly, health, the sweep route, the source resolver.

### The Operation table

Every Operation is one record: `name` (the MCP tool name), `method` and `path` (the HTTP face), `kind` (records' Call kind or none), `input` (a zod object), `handler(ctx, input)`. The HTTP router registers one route per Operation with `input.parse` on the body or query; the MCP factory registers one tool per Operation with the same `input` as `inputSchema`. Nothing is written twice.

| Operation             | HTTP                           | Call kind  | Does                                                                                                                            |
| --------------------- | ------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `render_image`        | `POST /v1/render`              | `render`   | template + placement + fields + Source Reference + framing options → a Render                                                   |
| `crop_image`          | `POST /v1/crop`                | `crop`     | Source Reference + target size + framing options → a Crop                                                                       |
| `find_subjects`       | `POST /v1/annotate`            | `annotate` | Source Reference + brand → the Annotation (prints stripped) and this Brand's Identification; files the source, stores no output |
| `list_templates`      | `GET /v1/templates?brand=`     | –          | compose `templates(brand)`; every Template of the Caller's Brands without `brand`                                               |
| `list_placements`     | `GET /v1/placements`           | –          | compose `PLACEMENTS`                                                                                                            |
| `list_brands`         | `GET /v1/brands`               | –          | the Caller's Brands with their names                                                                                            |
| `list_people`         | `GET /v1/people?brand=`        | –          | records `people.list` without the prints; Reference Photo ids and consent dates                                                 |
| `add_person`          | `POST /v1/people`              | –          | records `people.create`                                                                                                         |
| `erase_person`        | `DELETE /v1/people/:id?brand=` | `erase`    | records `people.erase`; answers the empty listing as proof                                                                      |
| `add_reference_photo` | `POST /v1/people/:id/photos`   | `enrol`    | identify `enrol`; a `choose` answer is a `200` with the faces, not an error                                                     |

Dropped from the prototype: `/v1/carousel` (out of compose v1), `/v1/gallery` (webui's), `/v1/channels` (a Placement names its Channel), `/v1/subjects` (renamed `annotate`).

### Inputs

- **Source Reference**: `source: { url } | { hash }`. `url` is `https:` only, fetched with the gateway's `fetch`, `Content-Length` and the stream bounded at the store's `MAX_OBJECT_BYTES`, refused with `source_unfetchable` (422) on any non-2xx, timeout (30 s) or empty body and with `too_large` (413) over the bound, hashed, then filed: `store.put("sources")` and `files.ensure` on the first sight of the bytes (the pipeline row below says when), `sources.hold(brand, hash)` on every call. `hash` requires `sources.heldBy(brand, hash)`, else `404 not_found`: a Brand may not name bytes it never sent, and the answer does not say whether the bytes exist.
- **Framing options**, shared by `render` and `crop`, all optional at the door: `pinTo` (default `DEFAULT_PIN_TO`), `persons`, `anchor`, `subjectArea` (crop only; render takes it from the Plan), `redaction.blurUnknownFaces` (default **true**), `format`, `quality`. `occlusion` is never an input: it comes from compose's Plan, or is empty for a Crop. The FramingRequest is built at the door and validated with contracts' schema before frame sees it, so a 17th Occlusion Zone or a bad ladder is a `400` from the contract itself.
- **`render`**: `template`, `placement`, `fields` (validated by compose, refused as `invalid_fields`), `brand`.
- **`crop`**: `brand`, `width`, `height`.
- **`brand`** is required on every Operation that touches a Brand's data; the Brand Wall runs on it before the handler.

### The pipeline

Per Call kind, in this order, each stage a Step:

| Stage                                                                                                                              | `render`                                                                                                                                                                                                                                                                                                                                                                                       | `crop`                                                                                             | `annotate`          |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------- |
| door                                                                                                                               | Caller, Brand Wall, `input.parse`                                                                                                                                                                                                                                                                                                                                                              | same                                                                                               | same                |
| `source.fetch` / `store.get`                                                                                                       | resolve the Source Reference: a `{ url }` fetched and hashed; a `{ hash }` checked against `sources.heldBy`, its bytes read off the store only when the cache below cannot answer                                                                                                                                                                                                              | same                                                                                               | same                |
| `records.replay`                                                                                                                   | `outputs.byRequest(brand, requestHash)`; a hit answers the Output, records a Call, stops                                                                                                                                                                                                                                                                                                       | same                                                                                               | –                   |
| `records.annotations.get` / `models.*` / `store.put` / `records.files.ensure` / `records.annotations.put` / `records.sources.hold` | `annotations.get(hash)`; a miss or `!isComplete(a, CATALOGUE)` → `models.annotate(bytes, { hash })` (its `Server-Timing` entries as `models.<stage>` Steps), then `store.put("sources")`, `files.ensure` (width, height and mime are the decoder's, so the File follows the Annotation and bytes models refused are never filed), `annotations.put`; `sources.hold(brand, hash)` on every path | same                                                                                               | same                |
| `identify.match`                                                                                                                   | `identify.match({ annotation, brand })`                                                                                                                                                                                                                                                                                                                                                        | same                                                                                               | same                |
| `compose.plan`                                                                                                                     | `plan({ template, placement, brand, fields })` → `target` = `imageSlot`, `occlusion`, `subjectArea`                                                                                                                                                                                                                                                                                            | `target` = `{ width, height }`, `occlusion: []`                                                    | –                   |
| `frame.crop`                                                                                                                       | `frameCrop({ annotation, matches, request })`                                                                                                                                                                                                                                                                                                                                                  | same                                                                                               | –                   |
| `source.decode`                                                                                                                    | sharp: EXIF-rotated raw RGB at the photograph's own size; assert `width/height === annotation.width/height` else `resolution_mismatch` (500)                                                                                                                                                                                                                                                   | same                                                                                               | –                   |
| `redact.blur`                                                                                                                      | `redact({ image, regions, matches, redaction })`                                                                                                                                                                                                                                                                                                                                               | same                                                                                               | –                   |
| `compose.render` / `compose.cut`                                                                                                   | `render({ ...plan input, source, window: framing.windowFraction, format, quality })`                                                                                                                                                                                                                                                                                                           | `cut({ source, window, target, format, quality })` (compose's Template-less path, ledgered on #84) | –                   |
| `store.put`                                                                                                                        | `renders`                                                                                                                                                                                                                                                                                                                                                                                      | `crops`                                                                                            | –                   |
| (the Call)                                                                                                                         | `outputs.record` + `calls.record`, one Call; not a Step, since the row cannot time its own write                                                                                                                                                                                                                                                                                               | same                                                                                               | `calls.record` only |

The decode happens once, after frame, because frame needs no pixel and a Replay needs no decode at all. The `resolution_mismatch` assert is the gateway's: frame divides by the Annotation's size, compose multiplies by the Decoded Image's, and only the gateway holds both (ledgered on #88).

`CATALOGUE` is the list of `{ name, version }` the gateway requires complete, read from `models.catalogue()` on the first pipeline request and memoised; a failed read is forgotten so the next request asks again, which is how a cold models is retried without a timer. `isComplete` against it is the cache test.

### Responses

- `render`, `crop`: `{ output: { url, key, kind, placement?, width, height, mime, bytes }, call: { id, replayed }, framing: Framing, faces: FaceReport[] }`. `FaceReport = { regionId, verdict, personId?, similarity?, hidden, inFrame }`: `verdict` from identify's Face Verdict, `hidden` when the Region id is in the Redaction Records, `inFrame` when `projectIntoFrame(framing, region.box)` intersects the unit box. A Replay answers the stored Output and `replayed: true`; `framing` and `faces` come from the replayed Call.
- `annotate`: `{ call: { id }, annotation, identification }`, `annotation.regions[].facePrint` removed. `identification` lands with the render ticket (#183), which wires identify in; until then the field is absent and the Call's `matches` is empty (decision on #88).
- `list_*`: `{ items: [...] }`, on both Doors. An object and not a bare array, because the MCP protocol types `structuredContent` as an object and the two Doors answer one shape (decided on #181). `erase_person`: records' Erasure with the empty listing.
- MCP: every result is `content: [{ type: "text", text: JSON }]` plus `structuredContent` with the same object; every error `isError: true` with the same `{ error }` JSON as text.

### Errors

`{ error: { code, message, details? } }` on both Doors, one flat code namespace, status from one table:

| Code                   | Status     | From                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_request`      | 400        | `input.parse` or the FramingRequest schema; `details` is zod's `treeifyError`                                                                                                                                                                                                                                                                                               |
| `unauthorized`         | 401        | no key, or `callers.byKey` null; `WWW-Authenticate: Basic realm="meco"` only under `/ui`                                                                                                                                                                                                                                                                                    |
| `brand_not_held`       | 403        | the Brand Wall                                                                                                                                                                                                                                                                                                                                                              |
| `not_found`            | 404        | unknown route, Person, Call, or a `hash` Source Reference without a Source Hold                                                                                                                                                                                                                                                                                             |
| `too_large`            | 413        | a Source over `MAX_OBJECT_BYTES`, by header or by stream                                                                                                                                                                                                                                                                                                                    |
| `source_unfetchable`   | 422        | the URL did not answer 2xx in time                                                                                                                                                                                                                                                                                                                                          |
| `resolution_mismatch`  | 500        | the gateway's own invariant                                                                                                                                                                                                                                                                                                                                                 |
| `models_unavailable`   | 503        | models `unreachable`, `timeout`, `model_unavailable`                                                                                                                                                                                                                                                                                                                        |
| module codes, verbatim | per module | compose `unknown_template` 404, `unknown_brand` 404, `placement_not_supported` 400, `invalid_fields` 400, `framing_mismatch` 500; identify `consent_required` 400, `unknown_person` 404, `no_face`/`unknown_region`/`too_small`/`not_a_face`/`no_print`/`other_model` 422; models `undecodable`/`unsupported_mime` 415, `too_large` 413, `bad_response`/`hash_mismatch` 502 |

The Call's `error` is `{ module, code, message }`; `module` is not on the wire. A failed Call is recorded before the error is answered.

### The door

`lib/auth.ts` (seeded by [#171](https://github.com/timschoch/meco/issues/171), owned here): `caller(request)` reads `Authorization: Bearer <key>`, `Authorization: Basic <base64(user:key)>` (user ignored) or `x-auth-token: <key>`, hashes, `callers.byKey`, once per request; the Caller rides on Hono's context. Every `/v1/*`, `/mcp` and `/ui/*` route requires one. `/health` requires none. `/internal/*` requires `Authorization: Bearer ${cronSecret}` and never a Caller key; with no `cronSecret` configured the routes do not exist. The Brand Wall is one function: `brand` from body, query or path against `caller.brands`, `403 brand_not_held` before the handler; list Operations with no `brand` iterate the Caller's Brands. `MECO_BOOTSTRAP_KEY` is the seed's; the gateway never reads it.

### The MCP Door

`createMcpHandler(() => server)` from `@modelcontextprotocol/server`, mounted with `app.all("/mcp", (c) => handler.fetch(c.req.raw))` behind the Caller middleware, stateless (the SDK's default). The factory builds one `McpServer` named `meco` at the gateway's version and registers one tool per Operation from the table, the tool's `inputSchema` being the Operation's zod object and its description the Operation's. The Caller reaches the tool handler through the request context, so the Brand Wall is the same call as on HTTP. Two doors, one table, one wall.

### Health

`GET /health` → `{ ok, service, version, probedAt, models: { bound, reachable, status, warm }, store: StoreHealth, records: RecordsReach }`. The three probes run behind one memoised promise with a 30 s TTL; `ok` is the gateway's own liveness and never depends on a probe. models: timeout 10 s; `warm` is true when models' `/health` lists every Model warm, `null` when it did not answer. Provenance for the cache: the store block costs 268 ms private and 246 ms public per request on the preview (#135), the records block one Neon round trip (#160), and the endpoint is unauthenticated.

### The Sweep

`POST /internal/sweep` → `records.sweep(now())`, answers the SweepReport. `vercel.json`: `"crons": [{ "path": "/internal/sweep", "schedule": "0 4 * * *" }]`; Vercel sends `Authorization: Bearer $CRON_SECRET`, and the whole header is compared in constant time. No boot timer. With no `cronSecret` the routes are never registered, so the path answers `404 not_found` like any unknown one — a deployment that forgot the variable must not have a door a guess could tell from a right key.

**Measured** (2026-09-06, #187). The route is reachable behind the catch-all rewrite: the branch preview answers `POST /internal/sweep` with no header as `401 unauthorized` where the production deployment without the route answers `404 not_found`, and `401` is only reachable once `CRON_SECRET` was injected and the check ran. The cron **invocation** is not measured on a preview: a cron runs against the production deployment, so `vercel crons list` reads `not deployed` and `vercel crons run /internal/sweep` answers `Error: No cron jobs found for timschochs-projects/meco` until the schedule is on production (`DEPLOY.md`, Crons). `CRON_SECRET` is Sensitive and therefore write-only, so nobody outside the platform can send the header a `200` needs; the first real invocation is the cron's own.

### The webui

`app.route("/ui", webui({ records, store, caller }))`, with `caller` the gateway's own lookup. One line; deletable.

### Boot

`server.ts`: `neonDatabase(RECORDS_DATABASE_URL_UNPOOLED)`, `blobStore()`, `createModelsClient({ baseUrl: MODELS_URL })`, `records.migrate()` (a failed migration is a failed boot), then `serve`. `CATALOGUE` is not read at boot: the first pipeline request asks `models.catalogue()` and the answer is memoised, a failure forgotten, so a cold models is retried by the next request and no timer; the gateway serves `/health` meanwhile and answers `503 models_unavailable` on the pipeline until it has a Catalogue (whatever models answered instead, a `bad_response` included).

### Configuration

| Variable                                                        | Set by                  | Purpose                                      |
| --------------------------------------------------------------- | ----------------------- | -------------------------------------------- |
| `MODELS_URL`                                                    | the service binding     | the models client's base URL                 |
| `RECORDS_DATABASE_URL_UNPOOLED`, `RECORDS_RETENTION_DAYS`       | Neon integration, owner | records (see its spec)                       |
| `BLOB_PUBLIC_STORE_ID`, `BLOB_PRIVATE_STORE_ID`, the two tokens | Blob stores             | store (see its spec)                         |
| `CRON_SECRET`                                                   | owner, Sensitive        | `/internal/*`; absent disables them          |
| `VERCEL_GIT_COMMIT_SHA`                                         | platform                | `/health` version and the MCP server version |

### Dependencies

`hono`, `@hono/node-server`, `@modelcontextprotocol/server`, `sharp` (one decode), and the entry points of `contracts`, `store`, `records`, `models` (`index.ts` only), `identify`, `frame`, `redact`, `compose` (`index.ts`, `placements.ts`), `webui`. No `pg`, no drizzle, no ONNX, no takumi import of its own.

## Testing decisions

Every test is `createApp(deps).request(...)`: the HTTP Door and, as JSON-RPC bodies to `/mcp`, the MCP Door, through the same seam. Dependencies are real where an adapter exists: `records({ database: pgliteDatabase(), store })`, `memoryStore()`, real `compose`, `frame`, `redact`, `identify`, and the real models client over a `fetch` fake that answers `/annotate` from committed fixture Annotations keyed by the body's sha256 (`fixtures/faces/detected.json` and `face-prints.json` lifted into contracts `Annotation` JSON, as frame's and identify's tests do) and `/health`, `/models` from fixtures. No models host code enters the gateway graph (ADR-0014). Prior art: `packages/gateway/tests/health.test.ts`, `packages/webui`'s plan, `packages/identify`'s fixture Annotator.

| Check                                                                                                                                               | Mutation that must turn it red       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| no key is `401`; a wrong key is `401`; `Bearer`, `Basic` and `x-auth-token` reach the same Caller                                                   | accept any key; drop one header form |
| a `brand` the Caller does not hold is `403 brand_not_held` on HTTP and as an MCP tool error, and no module ran                                      | check the Brand after the pipeline   |
| `tools/list` names every Operation and each `inputSchema` equals `z.toJSONSchema` of the route's input                                              | register one tool by hand            |
| `render` on the tracer-bullet fixture returns a `renders/` URL, a Framing with `resolvedBy` from the request's ladder, and one Face Report per face | drop the Face Report                 |
| the same `render` twice is one Output and two Calls, the second with one Step `records.replay`                                                      | hash the request with the URL in it  |
| two URLs serving the same bytes give one Output                                                                                                     | same                                 |
| `blurUnknownFaces` omitted hides every face with no Match; `false` hides none                                                                       | default to false                     |
| `pinTo` omitted reaches frame as `DEFAULT_PIN_TO`                                                                                                   | pass undefined                       |
| a 17-zone Template is refused `400 invalid_request` by the FramingRequest schema before frame                                                       | skip the schema                      |
| a Source over `MAX_OBJECT_BYTES` by `Content-Length` is `413` without reading the body; over by stream is `413`                                     | drop either check                    |
| a `hash` Source Reference without a Source Hold is `404`, identical to an unknown hash                                                              | answer 403                           |
| a cached, complete Annotation reaches no `models.annotate`; an incomplete one does and is replaced                                                  | skip `isComplete`                    |
| `annotate`'s response carries no `facePrint`                                                                                                        | forget to strip                      |
| a Decoded Image of the wrong size is `500 resolution_mismatch` and a failed Call                                                                    | drop the assert                      |
| every module's typed error maps to its code and status, and the Call's `error.module` names the module                                              | map one wrong                        |
| a failed Call is a row with `status: failed` before the error is answered                                                                           | record only on success               |
| `/health` answers from the cache within 30 s and probes again after; `models.warm` follows models' body                                             | probe per request                    |
| `/internal/sweep` is `401` without `CRON_SECRET`, `404` when none is configured, runs the Sweep with it                                             | skip the header check                |
| `GET /ui` without a header is `401` with `WWW-Authenticate: Basic`; `/v1/brands` without one is `401` without it                                    | send the challenge everywhere        |

Every check is proved able to fail by its mutation before it ships. Commit the green state first, then mutate, then `git restore`.

**Live, per ticket**: `packages/gateway/scripts/probe.ts` runs the ticket's Operation against a base URL with a key from the environment and prints the response and the Call id; the ticket posts it. The MCP ticket's live acceptance is `timschoch/meco-mcp-probe`, a separate repository holding one `tsx` script on `@modelcontextprotocol/client` 2.x that initialises, lists tools, and runs the tracer bullet (`list_brands`, `add_person`, `add_reference_photo`, `render_image`, `crop_image`, `erase_person`) against `MECO_URL` with `MECO_KEY`, exiting non-zero on any `isError`. Cloned into `.temp/meco-mcp-probe`, credentials never committed.

## Out of scope

- Quota, rate limits, pricing. The Caller on the context and `cost: null` on the Call are the seams.
- Accounts. `callers.brands` moves later (#77); the door does not change.
- Bytes in a request body (`POST /v1/sources`) and a Blob client upload: a ticket behind the 6 MB measurement of the public door.
- A JSON Gallery (`GET /v1/outputs`), an API route for a Source's Signed URL (webui's redirect is the only reader, ADR-0013), carousels, a caller's own Templates, per-consumer models, a token between the containers.
- Creating Brands or Callers over the API: the seed is the only writer.

## Further notes

`Caller`, `Call`, `Step`, `Output`, `Request Hash`, `Source Hold`, `Erasure` are records' terms; `Annotation`, `FramingRequest`, `Match` contracts'; `Framing` frame's; `Identification`, `Face Verdict` identify's; `Redaction Record` redact's; `Plan` compose's. The gateway section of `CONTEXT.md` adds `Door`, `Operation`, `Brand Wall`, `Source Reference`, `Replay` and `Face Report`.

Two requests this spec makes of neighbours, both ledgered: compose gains a Template-less `cut` (#84); records' `calls.matches` holds the whole Identification (#162).
