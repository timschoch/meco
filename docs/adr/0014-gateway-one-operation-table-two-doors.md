# ADR-0014 — gateway: one Operation table behind two Doors, the whole Catalogue per photograph, and a Request Hash over bytes

Status: **accepted, 6 Sep 2026**. Numbered 0014 by the orchestrator. Parent: [Module: gateway (#88)](https://github.com/timschoch/meco/issues/88), under the modular rebuild map [#60](https://github.com/timschoch/meco/issues/60). Settles [MCP lives inside the gateway (#66)](https://github.com/timschoch/meco/issues/66) and [How the gateway knows the caller (#77)](https://github.com/timschoch/meco/issues/77) in code shape. Spec: [`../specs/gateway.md`](../specs/gateway.md). Vocabulary: [`CONTEXT.md`, gateway](../../CONTEXT.md#gateway). Builds on [ADR-0005](0005-contracts-annotation-framingrequest-and-zod.md) (zod is the one schema library, so the contract, the validator and the MCP tool schema are one object), [ADR-0007](0007-models-one-route-two-stage-catalogue.md) (the wire and the thin client), [ADR-0009](0009-compose-takumi-measured-zones-look-in-code.md) (compose is the last pixel stage), [ADR-0011](0011-records-postgres-rows-counted-deletes-and-a-sweep.md) (Request Hash, Replay, the Sweep) and [ADR-0013](0013-webui-server-rendered-html-inside-the-gateway.md) (Basic auth at the door). Decided by the orchestrator with the gateway agent, the owner away; the grilling is ledgered on #88.

## Context

The prototype had one Hono app with fourteen `/v1` routes, a second file registering ten MCP tools by hand with their own zod objects, one `MECO_TOKEN` shared by every caller, and no record of what a call did. Every module of the rebuild is now designed or built and each has an entry point; what is left is the module that calls them in order and answers two protocols. The greenfield rule gives the prototype's shape no vote. Six choices below are the ones a later reader will want to reopen.

## Decision 1 — one Operation table drives both Doors

An **Operation** is defined once: a name, a Call kind, a zod input object, a handler from `(Caller, input)` to a result. The HTTP router and the MCP server are both generated from the same table; neither door has a hand-written schema. `z.toJSONSchema` on the same object is what an MCP client sees in `tools/list`, and `schema.parse` on the same object is what a `400 invalid_request` comes from.

Rejected: two surfaces maintained side by side, as the prototype did. Its `crop_image` tool and `/v1/crop` body had drifted in their `pinTo` vocabulary by the time the prototype was frozen. A drift between doors is the one bug this shape makes impossible rather than reviewable.

## Decision 2 — MCP is `createMcpHandler` inside the same Hono app, stateless, behind the same auth

`@modelcontextprotocol/server` 2.0.0's `createMcpHandler(factory)` returns a web-standard `fetch`; the gateway mounts it at `/mcp` and hands it `c.req.raw`. Stateless: one `McpServer` built per request from the Operation table, no session store, no SSE kept open. The Caller lookup runs as Hono middleware before the handler, so an unauthenticated tool call is an HTTP `401` and never reaches JSON-RPC; the Caller travels into the factory and the Brand Wall inside a tool is the same function as inside a route.

Measured 6 Sep 2026: the SDK is already in the lockfile from contracts' schema bench (ADR-0005), depends on `zod ^4.2`, and answers legacy `GET`/`DELETE` session operations with `405` itself, which is the close-the-stream behaviour [#1](https://github.com/timschoch/meco/issues/1) wanted. Rejected: a separate MCP service (a third container for ten tools), a sessionful transport (nothing in meco holds state between two tool calls), and image content in tool results (a Render is 0.7 to 2.5 MB and the agent wants the URL).

## Decision 3 — the whole Catalogue every time, and a Request Hash over bytes

The gateway asks models for every Catalogue entry on every first sight of a photograph. The Annotation is a cache shared by every Brand and every later call (ADR-0005), so a partial row would make `isComplete` false for the next consumer and cost a second inference on the same bytes. The price is D-FINE on a portrait; [#120](https://github.com/timschoch/meco/issues/120) measures it. A `pinTo`-driven subset was rejected for that reason.

The Request Hash covers the wire body with the Source Reference replaced by the Content Hash. Two URLs of one photograph are one Render; a URL is an address, not a fact about the output. The cost is one fetch before the lookup, which a caller who names the hash avoids.

## Decision 4 — ingress by URL or Content Hash; direct upload waits on a measurement

A Source Image arrives as `{ url }`, which the gateway fetches, bounds at the store's `MAX_OBJECT_BYTES`, hashes and files under `sources/`, or as `{ hash }` naming bytes the Brand already holds. Bytes in the request body are not in v1. [#30](https://github.com/timschoch/meco/issues/30) measured a 4.5 MB body cap on the function that fronted the prototype's container; whether the cap survives on the GA `services` public rewrite is unmeasured, and [#118](https://github.com/timschoch/meco/issues/118)'s measurement is over the _binding_, which says nothing about the public door. The gateway measures its own door on the first preview; `POST /v1/sources` is a ticket behind that number, with a Blob client upload as the recorded fallback. A tracer bullet needs only a URL.

## Decision 5 — the Sweep runs on a Vercel cron, not a boot timer

Records decided a boot timer for v1 ([#86](https://github.com/timschoch/meco/issues/86)). A container that scales to zero after five idle minutes runs only while someone is calling, which is exactly when a Sweep does not matter. So the gateway ships `/internal/sweep`, refused unless `Authorization: Bearer $CRON_SECRET` (Vercel's documented convention), and `vercel.json` gains `crons`. The boot timer is dropped: two triggers are two things to be wrong about. Whether a cron reaches a path served by a container behind the catch-all rewrite was documented nowhere; `vercel crons run` on production showed that it does, and that the dispatcher invokes with `GET`, so the route answers `GET` and `POST` (#187).

## Decision 6 — the safe defaults and the flat error vocabulary

- `redaction.blurUnknownFaces` defaults to **true** at the door. contracts requires the field; the gateway's input makes it optional; the default is the side the Brand Wall is on. The prototype defaulted to false.
- `pinTo` defaults to `DEFAULT_PIN_TO` at the door, so the contract never carries an absent ladder (ledgered on #88).
- Errors are `{ error: { code, message, details? } }` on both Doors, one flat code namespace: a module's typed code passes through verbatim, the gateway adds its own, and the status comes from one table. Codes were checked for collisions across compose, models, identify, records and gateway on 6 Sep 2026; none. `module` is on the Call record for the webui and not on the wire.
- The Caller is looked up from `Authorization: Bearer`, `Authorization: Basic` (ADR-0013) or `x-auth-token`. The third exists because Claude Desktop's connector dialog reserves `Authorization` for its own OAuth flow and greys it out, so a custom connector can set no other header; recorded by the prototype and kept on that fact.

## Considered and rejected

- **`persons` or a Brand default anywhere at the door.** Both belong to the FramingRequest and stay there (#67, #70).
- **A `result` column on `calls`** for the Face Report. The webui draws the Regions, the window and the Redaction Records over the source already; the report is computed for the wire from `projectIntoFrame` and not stored.
- **Storing `Match[]` alone on the Call.** The `matches` column holds identify's whole Identification, because the verdicts are what a reader needs and records stores jsonb unread. Clarified on [#162](https://github.com/timschoch/meco/issues/162); no migration.
- **Face Prints on the wire.** `POST /v1/annotate` strips them from the Regions. A 512-float biometric template of a stranger leaves the deployment for nobody.
- **The gateway cutting a bare Crop with sharp.** compose owns pixels; it gains a Template-less `cut` (ledgered on #84). The gateway decodes the source once for redact and compose and does nothing else to a pixel.
- **A gateway test importing `packages/models/app.ts`.** [#119](https://github.com/timschoch/meco/issues/119) narrows the container edge to `index.ts`; a test carve-out would widen the rule that keeps the two images apart. The suite fakes the wire with a `fetch` serving committed fixture Annotations by body hash, and the client stays real.

## Consequences

- Adding an Operation is one entry in one table and appears on both Doors, in `tools/list` and in the HTTP router, with one schema. Removing one is one deletion.
- The gateway's runtime dependencies are `hono`, `@hono/node-server`, `@modelcontextprotocol/server`, `sharp` (the one decode) and the nine module entry points. No new dependency for MCP beyond what ADR-0005 measured.
- `/health` becomes a 30 s memoised probe with a `records` block and `models.warm`; polling it costs nothing per hit. A first `/health` after models scaled to zero reports `reachable: true, warm: false` instead of a false `reachable: false`.
- The MCP door is proven by a client that shares none of meco's code: `timschoch/meco-mcp-probe`, a separate repository, is the live acceptance of the MCP ticket.
- The probe routes behind `GATEWAY_PROBE=1` (from [#141](https://github.com/timschoch/meco/pull/141)) are removed by the ticket that lands `/v1/annotate`, and only after #118 has taken its measurements through them.
