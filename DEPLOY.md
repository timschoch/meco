# Deploy

Container image build (`Dockerfile.vercel`) on Vercel Functions. Auto-detected —
no `services` config needed for this single-container project.

## One-time setup

1. Link the project: `vercel link`
2. Create the Blob store (adds `BLOB_READ_WRITE_TOKEN` to project env automatically):
   `vercel blob create-store meco --access public`
3. Set the bearer-auth env var for the server: run `vercel env add MECO_TOKEN`,
   pick `production` (repeat for `preview` / `development`), paste the value when prompted.

## Env vars

| Var | Set by | Purpose |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | `vercel blob create-store` | Vercel Blob read/write access |
| `MECO_TOKEN` | you (`vercel env add`) | bearer token the server checks on incoming requests |
| `PORT` | Vercel platform | container listen port; default 80, do not set manually |

Pull them locally when needed: `vercel env pull .env.local`

## Deploy

- Preview: `vercel deploy`
- Production: `vercel deploy --prod`

The build step builds `Dockerfile.vercel` and pushes it to Vercel Container
Registry. Watch progress with `vercel logs <deployment-url>` or `vercel inspect --logs`.

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
