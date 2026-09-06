# Deploy

Live: <https://meco-teal.vercel.app> — Vercel project
`timschochs-projects/meco`, connected to `github.com/timschoch/meco`.

## The shape

Two container services in one project, declared in `vercel.json`:

| Service   | Root | Entrypoint          | Public           |
| --------- | ---- | ------------------- | ---------------- |
| `gateway` | `.`  | `Containerfile`     | yes, all traffic |
| `models`  | `.`  | `Dockerfile.vercel` | no               |

A service is private unless a top-level `rewrites` entry names it. Only
`gateway` has one, so `models` is unreachable from the internet. `gateway`
reaches it through a **service binding**, which injects `MODELS_URL` at
runtime. The value is deployment-aware: a preview's `gateway` calls that same
preview's `models`, never production.

A binding grants access; it does not authenticate. Application-level
authorisation between the two services is the services' own job.

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

## Env vars

| Var                             | Set by                                  | Purpose                                                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MODELS_URL`                    | the service binding in `vercel.json`    | base URL `gateway` uses to reach `models`. Runtime only — it does not resolve during a build, and Routing Middleware cannot read it.                                                                                                                               |
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

The prototype's `BLOB_READ_WRITE_TOKEN`, `BLOB_PEOPLE_READ_WRITE_TOKEN` and
`MECO_TOKEN` are still set on the project. Nothing in this repo reads them yet;
the `store`, `records` and `gateway` module agents decide what to keep.

Pull them locally: `vercel env pull .env.local`

A **Sensitive** variable is write-only: `vercel env pull` writes a placeholder
of the wrong length, not the value. `CRON_SECRET` and `MECO_BOOTSTRAP_KEY` are
Sensitive, so nothing outside the platform can send the header they gate — a
hand-rolled `curl` against `/internal/sweep` gets `401`, and that is the
variable working, not a bug.

## Crons

`vercel.json` carries one, and one only: `POST /internal/sweep` at `0 4 * * *`.
The free plan allows a daily schedule and refused neither the entry nor the
path. A cron runs against the **production** deployment, so a `crons` entry
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

A deployment that carries the route answers `POST /internal/sweep` with no
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
