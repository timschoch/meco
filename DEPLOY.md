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

## Gotchas

- Never `docker cp` a macOS-built `node_modules` into the image — `sharp` and
  `@takumi-rs/core` are native addons and need the Linux build. The Dockerfile
  always runs a fresh `pnpm install` inside the container; keep it that way.
- Image must stay under 15 GB total / 500 MB per layer (Vercel Container
  Registry limit).
- Never advertise an MCP capability meco cannot honour. `tools.listChanged` is
  declared `false` on purpose: advertising it invites `subscriptions/listen`,
  which the SDK serves as an SSE stream held open for an event meco never
  sends. `src/mcp.ts` also declines that method outright.
