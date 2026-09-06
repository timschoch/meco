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

## Release

Push to `main`. Vercel builds both images and promotes them to production.

Out of band: `vercel deploy` (preview), `vercel deploy --prod` (production).
Watch a build with `vercel inspect --logs <deployment-url>`.

## Health

Both services answer `GET /health`.

```
curl https://meco-teal.vercel.app/health
{"ok":true,"service":"gateway","version":"<git sha>","models":{"bound":true,"reachable":true,"status":200}}
```

`ok` is the service's own liveness. On `gateway`, `models` carries the binding:
`bound` says `MODELS_URL` was injected, `reachable` says the probe got a `2xx`.
A `models` that is down does not make `gateway` unhealthy — it makes
`models.reachable` false.

`models` is private, so its `/health` is only observable through `gateway`'s
report or from inside the deployment.

`gateway` applies the `records` Migrations at boot, before it binds the socket,
and a failed migration is a failed boot with the error on stderr. `/health`'s
`records` block then reports the schema it is actually on: `pending: 0` and
`migrated: true` on a healthy container, and `reachable: true` only after a File
and its Annotation have been written and read back under a fixed hash.

## Env vars

| Var                             | Set by                                  | Purpose                                                                                                                                                                   |
| ------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODELS_URL`                    | the service binding in `vercel.json`    | base URL `gateway` uses to reach `models`. Runtime only — it does not resolve during a build, and Routing Middleware cannot read it.                                      |
| `PORT`                          | Vercel platform                         | container listen port, default 80. Do not set it.                                                                                                                         |
| `VERCEL_GIT_COMMIT_SHA`         | Vercel platform                         | what `/health` reports as `version`.                                                                                                                                      |
| `RECORDS_DATABASE_URL_UNPOOLED` | the Neon integration, prefix `RECORDS_` | the direct connection string `records` pools on and migrates through. Unset means no database: `/health` reports `records.configured: false` and the gateway still boots. |

Env vars are scoped per Environment (Production / Preview / Development) at the
project level, not per service: both services see the same set. Use distinct
names where two services would otherwise collide.

The Neon integration injects sixteen `RECORDS_*` variables. `records` reads the
one above and no other. It is the **direct** string, not the pooled one: the
container holds its own pool, and the migration takes a session-level advisory
lock that PgBouncer's transaction mode would not keep.

`records` rewrites its `sslmode` to `verify-full` before connecting. `pg` 8.23
treats `sslmode=require` — what Neon injects — as `no-verify` and warns on every
connect that it verifies nothing; the answer is to verify, not to silence the
warning, on a connection that carries personal data. Neon serves a certificate
from a public CA that Node already trusts, so nothing else has to be configured.
Measured on `meco-records-eu`, 6 Sep 2026: `verify-full` connects, and one
`/health` round trip from Zürich to `eu-central-1` took 241 ms.

The prototype's `BLOB_READ_WRITE_TOKEN`, `BLOB_PEOPLE_READ_WRITE_TOKEN` and
`MECO_TOKEN` are still set on the project. Nothing in this repo reads them yet;
the `store`, `records` and `gateway` module agents decide what to keep.

Pull them locally: `vercel env pull .env.local`

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

## Images

Each service builds from its own root-level file: multi-stage, pnpm install
from the workspace lockfile, `esbuild` bundles the entry point to one file, and
the runtime stage copies that file alone and runs as `node`. The bundle is why the runtime image carries no `node_modules`:
pnpm's workspace symlinks do not survive a `COPY`.

`HUSKY=0` is set in the build stage. Without it, `pnpm install` runs husky's
`prepare` script, which fails because `.git` is not in the build context.
