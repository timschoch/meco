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
| `create_upload`       | `POST /v1/sources/uploads`     | –          | a Signed URL to `PUT` a photograph to, scoped to one `sources/` key; see "Bytes in"                                             |
| `add_source`          | `POST /v1/sources`             | –          | files an uploaded photograph and answers its Content Hash, which the caller then names as `{ hash }`                            |

Dropped from the prototype: `/v1/carousel` (out of compose v1), `/v1/gallery` (webui's), `/v1/channels` (a Placement names its Channel), `/v1/subjects` (renamed `annotate`).

### Inputs

- **Source Reference**: `source: { url } | { hash }`. `url` is `https:` only, fetched with the gateway's `fetch`, `Content-Length` and the stream bounded at the store's `MAX_OBJECT_BYTES`, refused with `source_unfetchable` (422) on any non-2xx, timeout (30 s) or empty body and with `too_large` (413) over the bound, hashed, then filed: `store.put("sources")` and `files.ensure` on the first sight of the bytes (the pipeline row below says when), `sources.hold(brand, hash)` on every call. `hash` requires `sources.heldBy(brand, hash)`, else `404 not_found`: a Brand may not name bytes it never sent, and the answer does not say whether the bytes exist.
  `url` is followed by hand rather than by `fetch`, at most five hops, and every hop has to be `https:` — the schema can only check the one the caller typed, and a `302` down to `http:` or to a link-local address is not something a caller naming an https URL may do (#185).

  On `add_reference_photo` the resolver stops at the bytes: both forms are accepted and refused the same way, and the `store.put` / `files.ensure` / `sources.hold` half does not run. `identify.enrol` files these bytes itself, under `people/<brand>/<personId>`, with the Annotation's own width and height — which nothing has before models has answered. A Source Hold would also be half a Reference Count and would leave `people.erase` unable to take the File with the Person, so an Erasure would be partial (#185).

- **Framing options**, shared by `render` and `crop`, all optional at the door: `pinTo` (default `DEFAULT_PIN_TO`), `persons`, `anchor`, `subjectArea` (crop only; render takes it from the Plan), `redaction.blurUnknownFaces` (default **true**), `format`, `quality`. `occlusion` is never an input: it comes from compose's Plan, or is empty for a Crop. The FramingRequest is built at the door and validated with contracts' schema before frame sees it, so a 17th Occlusion Zone or a bad ladder is a `400` from the contract itself.
- **`render`**: `template`, `placement`, `fields` (validated by compose, refused as `invalid_fields`), `brand`.
- **`crop`**: `brand`, `width`, `height`.
- **`brand`** is required on every Operation that touches a Brand's data; the Brand Wall runs on it before the handler.

### Bytes in

A caller with a file and no URL uploads it to the Private Store itself. The
bytes never cross the gateway's door, because the door will not carry them.

**Measured** (6 Sep 2026, #188) on preview deployment
`dpl_BfArWcN91CXdFAteVeFMzxXduEwp`, by posting bodies of a known size to
`POST /v1/annotate` with a valid key: a `400 invalid_request` proves the whole
body reached the container and was read, a `413` is the platform's, ahead of
it.

| Request body                            | Answer                                            |
| --------------------------------------- | ------------------------------------------------- |
| 4 493 537 B                             | `400 invalid_request` — the gateway's             |
| 4 493 538 B                             | `413 FUNCTION_PAYLOAD_TOO_LARGE` — the platform's |
| 5 424 279 B (`artemis-2-crew-full.jpg`) | `413 FUNCTION_PAYLOAD_TOO_LARGE`                  |
| 6 MB                                    | `413 FUNCTION_PAYLOAD_TOO_LARGE`                  |

The cap counts the **whole request**, not the body: the same 4 493 537-byte
body with one extra 1 000-byte header is refused too. So it is a total-request
budget of 4.5 MB, and the largest body a client may send depends on the
headers it sends with it — there is no number a client could build against.
The GA `services` public rewrite therefore carries the same cap the function
that fronted the prototype's container had (#30), and ADR-0014's Decision 4 is
closed against a container rather than a function.

Two Operations, in the table like any other and therefore on both Doors,
because neither carries a photograph:

1. `create_upload` takes `{ brand, hash, mime, bytes }` — the caller's own
   SHA-256 of its file, what the file is, and how big — and answers
   `{ key, url, expiresAt, maxBytes }`. `url` is `store.uploadUrl`'s: a Signed
   URL scoped to `put`, to that one `sources/<hash>.<ext>` key, to that one
   content type and to that one size. Over `MAX_OBJECT_BYTES` is `413
too_large` before the store is asked.
2. The caller `PUT`s the file to `url`.
3. `add_source` takes `{ brand, key }` and answers `{ hash, key, bytes, mime }`.
   It reads the object and hashes it **itself**, reads the mime, width and
   height off the bytes with sharp's `metadata()` exactly as the models host's
   decoder does (`autoOrient` size included), and asks the store where those
   bytes belong. A key that is not the one `storeKeyFor` gives them is `400
invalid_request`. Then `files.ensure`, then `sources.hold(brand, hash)`.
   Bytes no decoder can read, or an image in a format no Annotation has a mime
   for, are `415 unsupported_mime`.

**A refusal about the bytes takes the object with it**: the `415`s and the
`400` for a key naming bytes that were never sent. Those bytes can never be
filed by anyone, records will never name them, and the Sweep only removes what
records knows about, so leaving them would leave them for good.

The refusals that are not about the bytes leave the object where it is, on
purpose. A `403` from the Brand Wall, or a throw between `store.put` and
`sources.hold`, says nothing against the photograph — it is at the key its own
Content Hash gives it, which is the key `add_source` will use next time, so
the caller's retry files it and uploads nothing. Deleting there would make a
caller who named the wrong Brand upload the whole file again.

**The Signed URL cannot overwrite**, and that is the guarantee the rest rests
on. A caller names the hash its key is built from, so it can name the hash of
a photograph another Brand filed. If that URL could write, it would replace
those bytes under a key still saying they are the old ones, and the Annotation
cached for that hash would describe a picture that is no longer there — for
every Brand, forever. The backend refusing the second write is also what makes
the delete above safe: whatever is at a key this caller minted, this caller
put there.

What this does **not** prove is that the caller sent the bytes rather than
guessing where they were. A Brand that knows the SHA-256 of a photograph
already in the store can call `add_source` on its key and be given a Source
Hold without uploading anything. Guessing a hash it has never held is a
256-bit search, so in practice knowing the hash is having had the bytes — the
same ground the `{ url }` path stands on, where supplying the bytes is what
earns the hold. Ledgered on #188 rather than defended against.

The caller's hash picks the key; the gateway's hash is what the File is
written under. `files.ensure` keeps the first row written, so a File whose
hash was not its bytes would poison the Annotation cache for every Brand,
forever — which is why the gateway never takes the caller's word for it, and
why `add_source` reads the same numbers off the same decoder the Annotation
will be read off.

A key outside the `sources/` Namespace is `400 invalid_request`: a Reference
Photo is `add_reference_photo`'s to file, under a Person, and an Erasure has
to be able to take it with them.

Considered and rejected: **bytes in the request body**, the shape this ticket
would have shipped had the door carried 6 MB. The measurement above is the
whole reason it did not. A hybrid — a body under the cap, an upload over it —
was rejected as well: the cap is not a number a client can compute, so the
rule "which of the two do I use" would have no answer.

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
- `annotate`: `{ call: { id }, annotation, identification }`, `annotation.regions[].facePrint` removed. The Call's `matches` holds the whole Identification, verdicts included (decision on #162).
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
| `too_large`            | 413        | a Source over `MAX_OBJECT_BYTES`, by header or by stream, or an upload declaring more                                                                                                                                                                                                                                                                                       |
| `unsupported_mime`     | 415        | an uploaded Source no decoder can read, or in a format no Annotation has a mime for. models raises the same code                                                                                                                                                                                                                                                            |
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

`GET /internal/sweep`, and `POST` on the same handler → `records.sweep(now())`, answers the SweepReport. `GET` because that is what Vercel's cron dispatcher sends (measured below); `POST` because the Sweep is idempotent and a hand-run reads better as one. Any other verb is `404`. `vercel.json`: `"crons": [{ "path": "/internal/sweep", "schedule": "0 4 * * *" }]`; Vercel sends `Authorization: Bearer $CRON_SECRET`, and the whole header is compared in constant time. No boot timer. With no `cronSecret` the routes are never registered, so the path answers `404 not_found` like any unknown one — a deployment that forgot the variable must not have a door a guess could tell from a right key.

**Measured** (2026-09-06, #187). A cron **does** reach a container behind the catch-all rewrite, and it invokes with `GET`. `vercel crons run /internal/sweep` on production at 13:11:05Z logged `requestMethod: "GET"`, `requestPath: "/internal/sweep"`, `responseStatusCode: 404` against `dpl_942v6K3KN7mbTxGNbfQ2s2ovGANX`, whose route was registered on `POST` alone — the `404` is the verb, not the secret, which `vercel env ls` confirms is set on Production. Hence `GET`. The boot timer does not return: the trigger works, the method was wrong. `CRON_SECRET` is Sensitive and therefore write-only, so nobody outside the platform can send the header a `200` needs; the cron is the only caller that can.

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

| Check                                                                                                                                                       | Mutation that must turn it red               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| no key is `401`; a wrong key is `401`; `Bearer`, `Basic` and `x-auth-token` reach the same Caller                                                           | accept any key; drop one header form         |
| a `brand` the Caller does not hold is `403 brand_not_held` on HTTP and as an MCP tool error, and no module ran                                              | check the Brand after the pipeline           |
| `tools/list` names every Operation and each `inputSchema` equals `z.toJSONSchema` of the route's input                                                      | register one tool by hand                    |
| `render` on the tracer-bullet fixture returns a `renders/` URL, a Framing with `resolvedBy` from the request's ladder, and one Face Report per face         | drop the Face Report                         |
| the same `render` twice is one Output and two Calls, the second with one Step `records.replay`                                                              | hash the request with the URL in it          |
| two URLs serving the same bytes give one Output                                                                                                             | same                                         |
| `blurUnknownFaces` omitted hides every face with no Match; `false` hides none                                                                               | default to false                             |
| `pinTo` omitted reaches frame as `DEFAULT_PIN_TO`                                                                                                           | pass undefined                               |
| a 17-zone Template is refused `400 invalid_request` by the FramingRequest schema before frame                                                               | skip the schema                              |
| a Source over `MAX_OBJECT_BYTES` by `Content-Length` is `413` without reading the body; over by stream is `413`                                             | drop either check                            |
| a `hash` Source Reference without a Source Hold is `404`, identical to an unknown hash                                                                      | answer 403                                   |
| `create_upload` answers the key `put` would give those bytes, files nothing, and is `413` over `MAX_OBJECT_BYTES`                                           | mint the key from anything else              |
| `add_source` hashes the object itself: bytes that do not hash to their key are `400` and deleted, and no File is written                                    | trust the caller's hash                      |
| `add_source` is `415` for bytes no decoder reads and for an image whose format no Annotation names, and `400` for a key outside `sources/`                  | file whatever sharp opened                   |
| a cached, complete Annotation reaches no `models.annotate`; an incomplete one does and is replaced                                                          | skip `isComplete`                            |
| `annotate`'s response carries no `facePrint`                                                                                                                | forget to strip                              |
| a Decoded Image of the wrong size is `500 resolution_mismatch` and a failed Call                                                                            | drop the assert                              |
| every module's typed error maps to its code and status, and the Call's `error.module` names the module                                                      | map one wrong                                |
| a failed Call is a row with `status: failed` before the error is answered                                                                                   | record only on success                       |
| `/health` answers from the cache within 30 s and probes again after; `models.warm` follows models' body                                                     | probe per request                            |
| `/internal/sweep` is `401` without `CRON_SECRET`, `404` when none is configured, runs the Sweep on `GET` and on `POST` with it, and `404`s an unlisted verb | skip the header check; register `POST` alone |
| `GET /ui` without a header is `401` with `WWW-Authenticate: Basic`; `/v1/brands` without one is `401` without it                                            | send the challenge everywhere                |

Every check is proved able to fail by its mutation before it ships. Commit the green state first, then mutate, then `git restore`.

**Live, per ticket**: `packages/gateway/scripts/probe.ts` runs the ticket's Operation against a base URL with a key from the environment and prints the response and the Call id; the ticket posts it. The MCP ticket's live acceptance is [`timschoch/meco-mcp-probe`](https://github.com/timschoch/meco-mcp-probe), a separate repository holding one `tsx` script on `@modelcontextprotocol/client` 2.x that initialises, lists tools, and runs the tracer bullet (`list_brands`, `add_person`, `add_reference_photo`, `find_subjects`, `render_image`, `crop_image`, `erase_person`) against `MECO_URL` with `MECO_KEY`, exiting non-zero on any `isError`. Cloned into `.temp/meco-mcp-probe`, credentials never committed. Run it with `npm install && MECO_URL=<base> MECO_KEY=<key> npm run probe`; `MECO_EXPECT_TOOLS` renames an expected tool, which is how the run is proved able to fail at `tools/list`.

**Measured** (2026-09-06, #186). The probe authenticates with `x-auth-token` and not `Authorization`, and that is a choice rather than a limit: the SDK's Streamable HTTP transport carries any header through `requestInit.headers`, and a second connection on `Authorization: Bearer` answers `list_brands` byte for byte the same. `x-auth-token` is the header a Claude Desktop custom connector can set, since its dialog reserves `Authorization` for its own OAuth flow (ADR-0014, Decision 6), so the probe travels the way the real client has to. A wrong key never reaches JSON-RPC: the Caller middleware answers HTTP `401` and the transport raises it as an `SdkHttpError` before `initialize`.

## Out of scope

- Quota, rate limits, pricing. The Caller on the context and `cost: null` on the Call are the seams.
- Accounts. `callers.brands` moves later (#77); the door does not change.
- A JSON Gallery (`GET /v1/outputs`), an API route for a Source's Signed URL (webui's redirect is the only reader, ADR-0013), carousels, a caller's own Templates, per-consumer models, a token between the containers.
- Creating Brands or Callers over the API: the seed is the only writer.

## Further notes

`Caller`, `Call`, `Step`, `Output`, `Request Hash`, `Source Hold`, `Erasure` are records' terms; `Annotation`, `FramingRequest`, `Match` contracts'; `Framing` frame's; `Identification`, `Face Verdict` identify's; `Redaction Record` redact's; `Plan` compose's. The gateway section of `CONTEXT.md` adds `Door`, `Operation`, `Brand Wall`, `Source Reference`, `Replay` and `Face Report`.

Two requests this spec makes of neighbours, both ledgered: compose gains a Template-less `cut` (#84); records' `calls.matches` holds the whole Identification (#162).
