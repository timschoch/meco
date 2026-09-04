# Deploy

Live: <https://meco-teal.vercel.app> — Vercel project `timschochs-projects/meco`.

Container image build (`Dockerfile.vercel`) on Vercel Functions. A root
`Dockerfile.vercel` is **not** auto-detected next to a `package.json`; the
`services` block in `vercel.json` is what selects the container runtime, and the
`rewrites` entry is what routes traffic into it.

The image compiles TypeScript at build time (`pnpm build` → `dist/`) and runs
`node dist/server.js`. `tsx` is for local development only: a scale-to-zero
container boots often, and transpiling `src/` on every boot is paid CPU.
`dist/` mirrors `src/` one level deep, which is what keeps `../assets` resolving
from `brands.ts`.

## Release

Push to `main`. The GitHub repo is connected to the project, so Vercel builds
the image and promotes it to production on its own.

Out-of-band deploys from the working tree: `vercel deploy` (preview),
`vercel deploy --prod` (production). Watch a build with
`vercel inspect --logs <deployment-url>`.

## One-time setup (already done)

1. `vercel link --project meco --scope timschochs-projects`
2. `vercel blob create-store meco-renders --access public --yes` — creates the
   store and writes `BLOB_READ_WRITE_TOKEN` into the project env.
3. `vercel env add MECO_TOKEN <environment>` for `production`, `preview` and
   `development` — the value is read from stdin.
4. `vercel project protection disable meco --sso` — Vercel Authentication would
   otherwise put an SSO wall in front of every request, and the point of the
   service is that other tools can call it. `MECO_TOKEN` is the auth.
5. `vercel git connect https://github.com/timschoch/meco`
6. Function max duration set to **60 s** (project setting
   `resourceConfig.functionDefaultTimeout`, Vercel default is 300 s). It is the
   backstop for any request that fails to end on its own; 60 s is well above any
   real render. Takes effect on the next deployment.

## One-time setup (still to do)

A second Blob store, private, for People. Only the account owner can create it.

```
vercel blob create-store meco-people --access private --yes
vercel env add BLOB_PEOPLE_READ_WRITE_TOKEN production   # and preview, development
```

The second command takes the new store's read/write token on stdin, under the
name meco reads. `create-store` writes its own token into the project env under
whatever name it picks, and the first store already holds `BLOB_READ_WRITE_TOKEN`.

Vercel Blob sets public or private **per store, not per object**: a private
write to the public store is refused by the API. Everything under the `people/`
prefix — Person records, Reference Photos, Face Prints — is personal data and
belongs in the private store. Until the store exists, meco refuses any write to
that prefix rather than putting a face photo of a named person on an open URL.
Nothing else changes: `renders/`, `carousels/` and `crops/` stay public.

## Env vars

| Var | Set by | Purpose |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | `vercel blob create-store` | Vercel Blob read/write access, public store |
| `BLOB_PEOPLE_READ_WRITE_TOKEN` | you (`vercel env add`) | read/write access to the private People store |
| `MECO_TOKEN` | you (`vercel env add`) | bearer token the server checks on incoming requests |
| `PORT` | Vercel platform | container listen port; default 80, do not set manually |

Pull them locally when needed: `vercel env pull .env.local`

## Test locally

Option A — through Vercel's dev server (needs Docker daemon running):

```
vercel dev
```

Option B — plain Docker, closer to CI, no Vercel account needed:

```
docker build -f Dockerfile.vercel -t meco .
docker run --rm -p 8080:80 \
  -e PORT=80 \
  -e BLOB_READ_WRITE_TOKEN=<token> \
  -e MECO_TOKEN=<token> \
  meco
curl http://localhost:8080/
```

## Prove an MCP exchange still ends

```
pnpm test:mcp
```

Drives every MCP exchange shape in-process and exits non-zero if any response
body is still open after five seconds. A body that never closes bills the
container until the platform kills it, so this is the guard on that.

## Prove both storage backends agree

```
pnpm test:storage
```

Runs one contract — write at a key, read the same bytes back, overwrite,
delete, ask for what is not there — against local disk and against Vercel Blob,
and checks that the Gallery never lists the People prefix. The Blob half needs
`BLOB_READ_WRITE_TOKEN` (it reads `.env.local` when there is one) and really
writes to the store, under a run-scoped `contract-test/` prefix it deletes
again. A missing token is a failure, not a skip: only one backend runs in
production, so an untested one is where a difference hides.

One check is skipped on each backend: that an unauthenticated GET of a
Reference Photo's URL does not return the bytes. On Blob it needs the private
store to exist; locally there is no public URL to ask, because the dev server
mounts the three public kinds by name and the People prefix has no route.

## meco-faces

A second container service in the **same** Vercel project, not a second project.
`vercel.json` declares both under `services` and separates them by rewrite:
`/faces/(.*)` goes to `meco-faces`, `/(.*)` to `meco`. The rewrites are ordered
and meco's catches everything, so the faces rule has to stay above it.

A rewrite whose destination is a service passes the path through unchanged, so
meco-faces mounts its routes at both `/` and `/faces` and answers the same way
behind the rewrite, behind a second project, or under plain `docker run`. That
also keeps the documented fallback — a separate `meco-faces` project reached by a
`FACES_URL` env var — a configuration change rather than a code change. Why the
service is separate at all: `docs/adr/0002-meco-faces-as-a-separate-service.md`.

The faces Dockerfile is named `Dockerfile.vercel` and lives in `packages/faces/`
because Vercel checks the **basename** of a service `entrypoint` and rejects
anything that is not a Dockerfile or a Containerfile — `Dockerfile.faces` at the
root fails the build with `invalid "entrypoint"`. It is still built from the
repository root, because the install needs the workspace lockfile.

`MECO_TOKEN` must be set on both services. `POST /faces/detect` requires it;
`GET /faces/health` does not, so that a liveness probe does not need a secret.

### Measured

| | |
|---|---|
| Image, `linux/amd64` | **370 MB** on disk, of which 234 MB is the `node:24-slim` base; **123 MB** as the registry stores it |
| Model | `face_detection_yunet_2026may.onnx`, 229,738 B, MIT, copied in at build time |
| Cold, 12 MP photo | **480 ms** from `docker run` to a served detection |
| Warm, 12 MP photo | **45 ms** median, 30–88 ms over 12 runs |

Measured on local Docker (Apple silicon, `linux/arm64`) against the real image,
not against the deployment: a preview URL sits behind Vercel's own routing and
scheduling, which would measure the platform rather than the service. A cold
start on Vercel is this number plus whatever the platform spends provisioning an
instance. Reproduce with:

```
docker build -f Containerfile -t meco-faces .
MECO_TOKEN=local-token pnpm --filter meco-faces exec tsx scripts/latency.ts \
  http://localhost:8788 12 -- \
  docker run --rm --name faces-lat -p 8788:80 -e PORT=80 -e MECO_TOKEN=local-token meco-faces
docker rm -f faces-lat
```

The 12 MP photo is a fixture enlarged to 3000×4000 at run time. What is being
timed is a decode and a fixed-size resize, and neither cares whether the detail
is real.

### Prove the detector still finds faces

```
pnpm test:detect
```

Runs `POST /detect` in-process over three public-domain photographs — four
faces, one face, none — and fails if a box moves more than 3 % of the image away
from the hand-marked one in `fixtures/faces/expected.json`. It also checks that
an unauthenticated request is refused and that `/health` names the model and the
ONNX Runtime version.

### Test locally

```
docker build -f Containerfile -t meco-faces .
docker run --rm -p 8788:80 -e PORT=80 -e MECO_TOKEN=<token> meco-faces
curl http://localhost:8788/health
curl -X POST http://localhost:8788/detect \
  -H "authorization: Bearer <token>" \
  --data-binary @fixtures/faces/astronaut-portrait.jpg
```

## Gotchas

- Never `docker cp` a macOS-built `node_modules` into the image — `sharp` and
  `@takumi-rs/core` are native addons and need the Linux build. The Dockerfile
  always runs a fresh `pnpm install` inside the container; keep it that way.
- Image must stay under 15 GB total / 500 MB per layer (Vercel Container
  Registry limit).
- `onnxruntime-node` unpacks to ~280 MB because it ships prebuilt binaries for
  all five platforms it supports, and its postinstall downloads CUDA provider
  binaries on `linux/x64` and nowhere else. `Containerfile` sets
  `ONNXRUNTIME_NODE_INSTALL=skip` and deletes every `bin/napi-v6` directory but
  the one `$TARGETARCH` needs. Keep both; either one alone leaves most of that
  weight in the image.
- Never advertise an MCP capability meco cannot honour. `tools.listChanged` is
  declared `false` on purpose: advertising it invites `subscriptions/listen`,
  which the SDK serves as an SSE stream held open for an event meco never
  sends. `src/mcp.ts` also declines that method outright.
