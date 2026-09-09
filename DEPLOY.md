# Deploy

Live: <https://meco-teal.vercel.app> — Vercel project
`timschochs-projects/meco`, connected to `github.com/timschoch/meco`.

## The shape

Two container services and one Node Function in one project, declared in
`vercel.json`:

| Service   | Root             | Entrypoint          | Public               |
| --------- | ---------------- | ------------------- | -------------------- |
| `front`   | `packages/front` | `server.ts`         | yes, `/mcp` only     |
| `gateway` | `.`              | `Containerfile`     | yes, everything else |
| `models`  | `.`              | `Dockerfile.vercel` | no                   |

A service is private unless a top-level `rewrites` entry names it. `/mcp` is
rewritten to `front` ahead of the catch-all to `gateway`, and `models` has no
rewrite, so it is unreachable from the internet. `gateway` reaches `models`
through a **service binding**, which injects `MODELS_URL` at runtime; `front`
reaches `gateway` the same way, as `GATEWAY_URL`. A binding's value is
deployment-aware: a preview's caller reaches that same preview's callee, never
production.

A binding grants access; it does not authenticate. Application-level
authorisation between the two services is the services' own job.

### The front

`front` is a Node Function, not a container. `packages/front/server.ts`
exports a web handler, `(Request) => Promise<Response>`, under `GET`, `POST`
and `DELETE` — the whole of MCP's Streamable HTTP surface — and **under no
default**; Vercel's Node-backends detection takes it as the entrypoint and
bundles it with its one dependency,
[`@timschoch/vercel-mcp-cold-start`](https://www.npmjs.com/package/@timschoch/vercel-mcp-cold-start).
`entrypoint: "server.ts"` pins that, because the detection order (`app`,
`index`, `server`, `main`) is worth naming rather than relying on. What it
does is in `docs/specs/gateway.md`, "The Front": every MCP message goes to
the container's `/mcp` over `GATEWAY_URL` as it came, and only a `tools/call`
that finds the container scaled to zero is told so on the stream.

The proxy itself is not meco's any more. It knew no tool and depended on no
meco package, so it was extracted and published; `server.ts` holds the wiring
only meco can know — the container behind `GATEWAY_URL`, the `/mcp` path on
it, the name `meco` in the notices, and `seconds: 7`, the measurement below.
The package's own default is `30`, a ceiling for a server nobody has
measured. Re-measure and change the number here when the gateway's boot
changes; the package will not know.

**The export shape picks the calling convention, and a wrong one is a `500`
on every request.** Vercel's Node runtime hands a web `Request`, whose `url`
is absolute, to a named `GET`/`POST`/`DELETE` or to a default _object_ with a
`fetch` method. A default _function_ is the old `(req, res)` handler and gets
Node's `IncomingMessage`, whose `url` is the path alone. The front reads
`request.url` to carry the query string over, so under the Node shape
`new URL("/mcp")` throws `ERR_INVALID_URL` before anything is forwarded.
Measured on preview `meco-2wnvgnsc3` (#252): the file exported the three verbs
_and_ a default function, the default won, and `GET /mcp` was
`FUNCTION_INVOCATION_FAILED` in 1.14 s while `/health` on the container
answered `200`. Do not add a default export back; `packages/front/tests/`
fails if one appears.

**Measured** (6 Sep 2026, #205), all from Zürich, which enters Vercel at
`iad1` and pays about 0.75 s per round trip before anything runs (an unknown
path's `404` from the container: 0.75–0.85 s over eight hits).

- **The shape builds.** Preview `meco-e6h0pvo9n`, commit `4a9c897`:
  `+ hono 4.13.3`, `✓ Build complete — Using server.ts as the root
entrypoint.` The log also says `Shared workspace lockfile detected but
configuration forces legacy deploy implementation`; it installed from the
  workspace lockfile regardless. The container fallback for the front was
  not needed.
- **Warm overhead.** Fifteen A/B rounds, each round the same message to the
  front (preview `meco-lnfc5w04u`) and then to the previous preview's
  container-direct `/mcp` (`meco-3giklictc`, `main` before this branch):

  | Message                  | Front, median | Direct, median | Front, min | Direct, min |
  | ------------------------ | ------------- | -------------- | ---------- | ----------- |
  | `tools/list`             | 873 ms        | 824 ms         | 676 ms     | 668 ms      |
  | `tools/call list_brands` | 836 ms        | 800 ms         | 780 ms     | 663 ms      |

  The hop costs about 40–120 ms on a ~0.7 s baseline. The probe beside a
  `tools/call` adds nothing the caller waits for: the call is already on its
  way.

- **Cold.** After 95 s idle (a preview scales down after 30 s), one
  `tools/call list_brands` through the front, stamped at the client:

  ```
  1.811 s  HTTP/2 200                       content-type: text/event-stream
  1.901 s  notifications/message            "meco is starting, about 7 seconds"
  4.349 s  notifications/message            "meco is up, your request is now being processed"
  4.429 s  result                           {"items":[{"id":"hopefamily",…
  ```

  After 400 s idle, past production's five-minute scale-down: status line at
  2.11 s, notice at about 2.3 s, confirmation at 5.06 s, result at 5.28 s
  (the client stamped each line through `bc`, which drifts the later stamps
  by about 0.1 s a line; the first is exact). The ticket asked for the notice
  inside 1 s; from here it is not, and the budget below says where the time
  goes. The first byte is the network baseline, the Function's own cold
  start and the 500 ms the probe is given, in that order. The container's cold start,
  first byte to confirmation, was 2.4 s here and 4.8 s on the first build
  (notice at 2.19 s, confirmation at 6.95 s); the first `/health` after a
  deploy answered `200` after 7.25 s. **7 s** is what the notice promises
  (`coldStart.seconds` in `packages/front/server.ts`); re-measure
  it when the gateway's boot changes.

- **Why the probe is `GET /mcp` and not `/health`.** Eight alternating hits
  on `meco-3giklictc`: `GET /health` answered in 0.81–1.10 s while its 30 s
  cache was fresh and in 3.67–4.22 s when it was stale (the store and
  records probes run), where the `404` above took 0.75–0.85 s. A probe on
  `/health` would overrun any timeout every 30 s and call a warm container
  cold. `GET /mcp` with no key is a `401` from the Caller middleware, with no
  store or database behind it.

- **On production**, deployment `dpl_CCD4vWzW7861UqueuRtVR7M8NkLK`, from Zürich.
  The front runs in `fra1`, beside the containers. Warm, the hop costs 40–50 ms
  at the median over fifteen rounds. Cold, after 400 s idle:

  | Stamp        | At     |
  | ------------ | ------ |
  | first byte   | 2.08 s |
  | cold notice  | 2.13 s |
  | confirmation | 4.74 s |
  | result       | 4.79 s |

- **`x-vercel-id`'s first segment is the edge PoP, not the Function's region.**
  A warm `initialize` through the front carried `iad1:iad1:fra1…` and read as a
  Function in `iad1` beside a `fra1` container. It was not: the request entered
  Vercel at `iad1`, which is where Zürich enters, and the Function ran in `fra1`
  throughout. Read the region off the project's Function configuration, never off
  this header.

### The two entrypoint traps, re-measured

`docs/research/vercel-two-services.md` read the current docs as saying the build
context is the service's `root`, and could find no trace of the basename
restriction. Both traps the prototype paid for are still live under GA
`services`, and each cost a preview build to confirm. **Do not tidy either of
these away.**

**1. The `entrypoint` basename must come from Vercel's fixed list.** A
descriptive name is refused before anything is built — deployment
`dpl_2r67PFbajSyQAeqw9LKbu2eM26mK`, 5 Sep 2026:

```
Error: Container service "gateway" has invalid "entrypoint" "Containerfile.gateway".
It must name a Dockerfile or Containerfile.
```

That is why one service's file is `Containerfile` and the other's is
`Dockerfile.vercel`. The names say nothing about which service they build;
`vercel.json` and each file's first line do.

**2. The build context is the entrypoint's own directory, not the service's
`root`.** Deployment `dpl_7q2U1yZ228j4crCeoB6UyvdUcSjL`, 5 Sep 2026, with
`root: "."` and `entrypoint: "packages/gateway/Containerfile"`:

```
Error: building at STEP "COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./":
checking on sources under "/vercel/path0/packages/gateway":
copier: stat: "/pnpm-lock.yaml": no such file or directory
buildah build ... -f /vercel/path0/packages/gateway/Containerfile /vercel/path0/packages/gateway
```

A pnpm workspace cannot install from one package directory — the lockfile and
`pnpm-workspace.yaml` are at the top — so the context has to be the repository
root, so the Containerfile has to live there. `root: "."` still matters: it is
what makes `entrypoint` resolve from the repository root.

Together the two traps force the shape: root-level files, named from Vercel's
list, one per service.

### The third trap: an ESM bundle has no `require`

`format: "esm"` leaves a CommonJS dependency's `require(…)` to a shim esbuild
generates, and that shim throws. `@meco/store` pulls `@vercel/blob`, which
reaches `jose` through `@vercel/oidc`, and jose's CommonJS build requires
`node:buffer` that way. The container started, answered nothing and exited —
deployment `dpl_3paWgFYje3P2EQxHgrvzDUQQgj3S`, 6 Sep 2026:

```
Error: Dynamic require of "node:buffer" is not supported
    at ../../node_modules/.pnpm/jose@5.10.0/.../runtime/base64url.js
Application exited with code 1.
```

esbuild's shim defers to a `require` that is already in scope, so a
`createRequire` banner in the service's `build.mjs` is the whole fix. `gateway`
has one. **Any service that bundles a CommonJS dependency needs it**, and the
symptom is a healthy build followed by `FUNCTION_INVOCATION_FAILED` on the
first request — not a build error.

### The fourth trap: a bundled module still needs its files

compose's index carries `sharp` and `@takumi-rs/core`, which load native
binaries by their own paths and cannot be bundled (the `models` image keeps
`sharp` and `onnxruntime-node` outside its bundle for the same reason).
Measured 6 Sep 2026 with the gateway's `build.mjs`, after #212 made compose
read its fonts on first use: the compose chunk builds and dies at load with
`ERR_MODULE_NOT_FOUND Cannot find package '@takumi-rs/core'` from any directory
with no `node_modules` above it, which is what the runtime image is.

Closed by #183, in two halves.

**The natives.** `packages/gateway/build.mjs` marks the two `external` and the
`Containerfile` runtime stage carries a flat `node_modules` from
`pnpm --filter @meco/gateway --prod deploy`, the same recipe
`Dockerfile.vercel` uses for `models`. The bundle is one file again: splitting
existed only to keep the compose import out of boot while the natives were
missing.

**The files.** A Look reads its fonts and its wordmark on first use, and a
bundle sits nowhere near them. Each Look's folder is copied to
`dist/bundle/<brand>/` and compose resolves
`<the module's own directory>/<brand>/<file>`, which is `lib/looks/<brand>/` in
source and the bundle's own folder in the image — the shape `models` already
uses for an adapter's weights. Keyed by the Brand and not by each Look's
`import.meta.url`, because a bundler collapses the three Looks into one file
where three `./logo.png` reads would resolve to one path.

`packages/compose/tests/bundle.test.ts` holds both halves: a bundle loads with
no assets on disk, and renders with them laid out this way.

## Release

Push to `main`. Vercel builds both images and promotes them to production.

Out of band: `vercel deploy` (preview), `vercel deploy --prod` (production).
Watch a build with `vercel inspect --logs <deployment-url>`.

## Health

Both services answer `GET /health`.

```
curl https://meco-teal.vercel.app/health
{"ok":true,"service":"gateway","version":"<git sha>","probedAt":"<ISO 8601>","models":{"bound":true,"reachable":true,"status":200,"warm":true},"store":{…},"records":{…}}
```

`ok` is the service's own liveness. On `gateway`, `models` carries the binding:
`bound` says `MODELS_URL` was injected, `reachable` says the probe got a `2xx`
within 10 s, `warm` says every Model on the answering instance has its session
(`null` when models did not answer; `reachable: true, warm: false` is a cold
start in progress). A `models` that is down does not make `gateway` unhealthy —
it makes `models.reachable` false.

The three blocks are probed together behind one 30 s cache, so polling
`/health` costs no Blob or Neon round trip per hit; `probedAt` says when the
body was measured. `/health` needs no key; every `/v1/*`, `/mcp` and `/ui`
route does (`docs/specs/gateway.md`, "The door").

`models` is private, so its `/health` is only observable through `gateway`'s
report or from inside the deployment.

`gateway` applies the `records` Migrations at boot, before it binds the socket,
and a failed migration is a failed boot with the error on stderr. `/health`'s
`records` block then reports the schema it is actually on: `pending: 0` and
`migrated: true` on a healthy container, and `reachable: true` only after a File
and its Annotation have been written and read back under a fixed hash.

### Verify the MCP Door

[`timschoch/meco-mcp-probe`](https://github.com/timschoch/meco-mcp-probe) runs
the whole story over `/mcp` from an MCP client that shares none of meco's code:
`npm install`, then
`MECO_URL=<base> MECO_KEY=<key> npm run probe`. Exit 0 means every check
passed, and the Person it enrols is erased before it exits.

### models routes

[`docs/specs/models.md`](docs/specs/models.md) is the contract. On the wire:

| Route                       | Answers                                                                         |
| --------------------------- | ------------------------------------------------------------------------------- |
| `POST /annotate?models=a,b` | the contracts Annotation for the image bytes in the body; `Server-Timing` set   |
| `GET /models`               | the Catalogue: `{ name, version, kinds, licence, warm }[]`, licence as its id   |
| `GET /health`               | `{ ok, service, version, models: [{ name, version, warm }], onnxruntime, rss }` |

`warm` and `rss` are true of the instance that answered, never of the
deployment. The instance listens before it creates its sessions, so a `/health`
in the first second of a cold start reports `warm: false` and the first
`/annotate` waits on the same create.

The probe, against any base URL that reaches `models`:

```
pnpm --filter @meco/models probe http://127.0.0.1:8791 [fixture] [models]
```

It calls through `@meco/models`' client with the hash check on, so a live run
crosses the seam the gateway crosses. It prints `/health` and the Catalogue
first, then the wall time, `Server-Timing` and the Annotation, and `/health`
once more; a refusal prints its `ModelsError` code and exits 1. Default
fixture: `fixtures/faces/artemis-2-crew.jpg`.

## Where a render Call's time goes

Measured on production, 2026-09-06, Call `e0db031c`, a 384 KB JPEG through
`/v1/render` with both stores in `fra1`: **2.3 s** wall, of which **`store.put`
is 1.7 s** — three quarters of the Call, and more than the decode, the models
round trip and the render put together. A lead for later, not a change made
here: the Steps on the Call View are where to re-measure it.

## Env vars

| Var                             | Set by                                  | Purpose                                                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MODELS_URL`                    | the service binding in `vercel.json`    | base URL `gateway` uses to reach `models`. Runtime only — it does not resolve during a build, and Routing Middleware cannot read it.                                                                                                                               |
| `GATEWAY_URL`                   | the service binding in `vercel.json`    | base URL `front` uses to reach `gateway`. Runtime only, like `MODELS_URL`; unset, the front fails its first request with the variable named.                                                                                                                       |
| `PORT`                          | Vercel platform                         | container listen port, default 80. Do not set it.                                                                                                                                                                                                                  |
| `VERCEL_GIT_COMMIT_SHA`         | Vercel platform                         | what `/health` reports as `version`.                                                                                                                                                                                                                               |
| `RECORDS_DATABASE_URL_UNPOOLED` | the Neon integration, prefix `RECORDS_` | the direct connection string `records` pools on and migrates through. Unset is a failed boot with the variable named on stderr: every Operation starts with a Caller lookup, so a gateway with no database has no door.                                            |
| `MECO_BOOTSTRAP_KEY`            | owner, Sensitive                        | read by `pnpm records:seed` only, never by the gateway. The seed stores its SHA-256 on the bootstrap Caller; the key itself is what a client sends as `Authorization: Bearer`, `Authorization: Basic` (any user, the key as password) or `x-auth-token`.           |
| `CRON_SECRET`                   | owner, Sensitive                        | the only key `/internal/*` answers to. Vercel sends it as `Authorization: Bearer` on every cron it runs; the gateway compares the whole header in constant time. Unset, and `/internal/sweep` is not registered at all, so it answers `404` like any unknown path. |

Env vars are scoped per Environment (Production / Preview / Development) at the
project level, not per service: both services see the same set. Use distinct
names where two services would otherwise collide.

The Neon integration injects sixteen `RECORDS_*` variables. `records` reads the
one above and no other. It is the **direct** string, not the pooled one: the
container holds its own pool, and the migration takes a session-level advisory
lock that PgBouncer's transaction mode would not keep.

`records` pins `sslmode=verify-full` in the query of that string before
connecting. Neon injects `sslmode=require`, which `pg` 8.23 already treats as
`verify-full` — but it warns on every connect that pg 9 will give `prefer`,
`require` and `verify-ca` libpq semantics, which verify nothing. Naming the mode
is what keeps this connection verified across that change, and it is the fix the
warning itself names. Neon's certificate comes from a public CA Node already
trusts, so no root has to be supplied.

The pin edits the query and nothing else. Parsing the string with `new URL` and
re-serialising it would rewrite the userinfo too, and a rotated password with a
reserved character in it would come back encoded differently.

Measured on `meco-records-eu`, 6 Sep 2026: `verify-full` connects with no
warning, and one `/health` round trip from Zürich to `eu-central-1` took 241 ms.

`BLOB_READ_WRITE_TOKEN` and `BLOB_PEOPLE_READ_WRITE_TOKEN` are what reaches the
two Blob stores. `MECO_TOKEN` is the prototype's and nothing reads it.

**OIDC does not reach a container.** `@meco/store` prefers `VERCEL_OIDC_TOKEN`
because it rotates itself and falls back to the store's own read-write token
(`packages/store/lib/credentials.ts`), and it reports which one carried the call
as the Credential Source rather than assuming. Vercel injects that token into
Functions, not into container services, so on production both stores answer
`"credential": "token"` in `/health` — read it off the running deployment, not
off this sentence. Unset both and the store refuses by name; nothing falls back
to the other store.

Pull them locally: `vercel env pull .env.local`

A **Sensitive** variable is write-only: `vercel env pull` writes a placeholder
of the wrong length, not the value. `CRON_SECRET` and `MECO_BOOTSTRAP_KEY` are
Sensitive, so nothing outside the platform can send the header they gate — a
hand-rolled `curl` against `/internal/sweep` gets `401`, and that is the
variable working, not a bug.

## Crons

`vercel.json` carries one, and one only: `/internal/sweep` at `0 4 * * *`. The
free plan allows a daily schedule and refused neither the entry nor the path.

**A cron reaches a container behind the catch-all rewrite, and it invokes with
`GET`.** Measured on production, 2026-09-06: `vercel crons run /internal/sweep`
at 13:11:05Z reached `dpl_942v6K3KN7mbTxGNbfQ2s2ovGANX` and the runtime log read
`requestMethod: "GET"`, `requestPath: "/internal/sweep"`,
`responseStatusCode: 404` — the route was registered on `POST` alone, so the
`404` is the verb and not the secret, which `vercel env ls` confirms is set on
Production. The route answers `GET` and `POST` since (#187). Vercel documents
the header a cron sends and not the method, so this is the fact to keep. A cron runs against the **production** deployment, so a `crons` entry
that has only ever been pushed to a branch reads as `not deployed` and
`vercel crons run /internal/sweep` refuses it:

```
$ vercel crons list
  Path               Schedule            Status
  /internal/sweep    0 4 * * *           not deployed
WARNING! Run `vercel deploy --prod` to apply local changes.

$ vercel crons run /internal/sweep
Error: No cron jobs found for timschochs-projects/meco. Define cron jobs in
your vercel.json file.
```

A deployment that carries the route answers `/internal/sweep` with no
header as `401 unauthorized`, never `404`: the routes are registered only when
`CRON_SECRET` is set, so `401` says the request reached the container, the
variable was injected, and the header check ran. That is the reachability check
to run after a deploy; `docs/specs/gateway.md`, "The Sweep", carries what it
measured on 2026-09-06.

There is **no keep-warm cron**. One daily cron is the whole schedule; a cron
every few minutes spends the free plan's compute (#88, 2026-09-06).

## Scale to zero

Container services scale down after 5 minutes idle in production, 30 seconds in
preview. On scale-down the container gets `SIGTERM` and 30 seconds to finish.
Billing is Active CPU: an idle instance costs nothing while it waits.

## Run it locally

```
pnpm install
pnpm build
PORT=8791 node packages/models/dist/bundle/server.js &
PORT=8790 MODELS_URL=http://127.0.0.1:8791 node packages/gateway/dist/bundle/server.js &
curl http://127.0.0.1:8790/health
```

Or through Vercel's own dev server, which honours the bindings and needs a
running Docker daemon: `vercel dev`.

### An exported variable beats `.env.local`

`process.loadEnvFile` never overrides a variable already exported in the shell,
so a stale export wins silently and `vercel env pull` does not dislodge it. Cost
an afternoon on 6 Sep 2026: an exported `RECORDS_DATABASE_URL_UNPOOLED` from the
deleted `us-east-1` project beat the file, and the failure read as a password
rejection from `meco-records-eu` rather than as the wrong host.

`vitest.live.config.ts` is therefore immune by construction — it parses
`.env.local` with `util.parseEnv` and forwards those values by name, so the file
`vercel env pull` just wrote is what the live suites use. That matters most for
`pnpm test:records:live`, which creates and drops databases: pointed at the wrong
server by a stale export, it would drop them there. `unset` anything you exported
by hand before running one, and check the host each suite prints.

### A stale `VERCEL_OIDC_TOKEN` reads as "Access denied"

`vercel env pull` writes a `VERCEL_OIDC_TOKEN` scoped to **Development**, and
`.envrc` exports it. The store prefers it over the store's own read-write token,
so a laptop pointed at the production stores presents a Development credential
and Vercel Blob answers `Access denied` — a wrong-credential failure that reads
like a wrong-token one. The token also expires within hours, so a pull from this
morning fails the same way this afternoon. Re-pull, or `unset VERCEL_OIDC_TOKEN`
to fall through to the store token. `/health`'s `credential` field says which one
a call actually used.

## Images

Each service builds from its own root-level file: multi-stage, pnpm install
from the workspace lockfile, `esbuild` bundles the entry point to one file, and
the runtime stage runs it as `node`. `gateway` copies the bundle alone and
carries no `node_modules`: pnpm's workspace symlinks do not survive a `COPY`.

`models` differs in four ways, each for a reason in
[ADR-0007](docs/adr/0007-models-one-route-two-stage-catalogue.md):

- `node:24-slim`, not alpine. `onnxruntime-node` ships glibc binaries only.
- `onnxruntime-node` and `sharp` stay outside the bundle: both load native
  binaries by their own paths. `pnpm --filter @meco/models --prod deploy` lays
  them flat in a `node_modules` the runtime stage copies, with the ONNX Runtime
  binaries pruned to the build's `TARGETARCH` (the tarball carries five
  platforms). Measured 6 Sep 2026: 110 MB image for `linux/amd64`.
- `ORT_DISABLE_TELEMETRY=1` and `ONNXRUNTIME_NODE_INSTALL=skip` in the image.
  The first stops the 1.29 Linux binary's telemetry; the second stops a
  postinstall that downloads CUDA libraries. `pnpm-workspace.yaml` refuses that
  postinstall for local installs too.
- Each adapter's weights and `LICENCE.txt` are copied into the bundle
  directory by `packages/models/build.mjs`, never fetched at runtime.

`HUSKY=0` is set in both build stages. Without it, `pnpm install` runs husky's
`prepare` script, which fails because `.git` is not in the build context.
