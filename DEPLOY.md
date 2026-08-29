# Deploy

Live: <https://meco-teal.vercel.app> — Vercel project `timschochs-projects/meco`.

Container image build (`Dockerfile.vercel`) on Vercel Functions. A root
`Dockerfile.vercel` is **not** auto-detected next to a `package.json`; the
`services` block in `vercel.json` is what selects the container runtime, and the
`rewrites` entry is what routes traffic into it.

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
   `resourceConfig.functionDefaultTimeout`, Vercel default is 300 s). An MCP
   client that holds the `/mcp` response stream open otherwise keeps the
   container — and the billing — alive for the full 300 s. 60 s is well above
   any real render. Takes effect on the next deployment.

## Env vars

| Var | Set by | Purpose |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | `vercel blob create-store` | Vercel Blob read/write access |
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

## Gotchas

- Never `docker cp` a macOS-built `node_modules` into the image — `sharp` and
  `@takumi-rs/core` are native addons and need the Linux build. The Dockerfile
  always runs a fresh `pnpm install` inside the container; keep it that way.
- Image must stay under 15 GB total / 500 MB per layer (Vercel Container
  Registry limit).
