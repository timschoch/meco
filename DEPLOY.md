# Deploy

Live: <https://meco-teal.vercel.app> — Vercel project
`timschochs-projects/meco`, connected to `github.com/timschoch/meco`.

## The shape

Two container services in one project, declared in `vercel.json`:

| Service   | Root | Entrypoint                       | Public           |
| --------- | ---- | -------------------------------- | ---------------- |
| `gateway` | `.`  | `packages/gateway/Containerfile` | yes, all traffic |
| `models`  | `.`  | `packages/models/Containerfile`  | no               |

A service is private unless a top-level `rewrites` entry names it. Only
`gateway` has one, so `models` is unreachable from the internet. `gateway`
reaches it through a **service binding**, which injects `MODELS_URL` at
runtime. The value is deployment-aware: a preview's `gateway` calls that same
preview's `models`, never production.

A binding grants access; it does not authenticate. Application-level
authorisation between the two services is the services' own job.

Both `root`s are the repository root, because a pnpm workspace cannot install
from a single package directory: the lockfile and `pnpm-workspace.yaml` live at
the top. `entrypoint` is a path relative to that root — see
`docs/research/vercel-two-services.md` for the primary sources, and for the two
build traps the prototype paid for under the older container mechanism.

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

## Env vars

| Var                     | Set by                               | Purpose                                                                                                                              |
| ----------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `MODELS_URL`            | the service binding in `vercel.json` | base URL `gateway` uses to reach `models`. Runtime only — it does not resolve during a build, and Routing Middleware cannot read it. |
| `PORT`                  | Vercel platform                      | container listen port, default 80. Do not set it.                                                                                    |
| `VERCEL_GIT_COMMIT_SHA` | Vercel platform                      | what `/health` reports as `version`.                                                                                                 |

Env vars are scoped per Environment (Production / Preview / Development) at the
project level, not per service: both services see the same set. Use distinct
names where two services would otherwise collide.

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

Each service builds from its own `Containerfile` in its package root:
multi-stage, pnpm install from the workspace lockfile, `esbuild` bundles the
entry point to one file, and the runtime stage copies that file alone and runs
as `node`. The bundle is why the runtime image carries no `node_modules`:
pnpm's workspace symlinks do not survive a `COPY`.

`HUSKY=0` is set in the build stage. Without it, `pnpm install` runs husky's
`prepare` script, which fails because `.git` is not in the build context.
