# meco

Turns code-authored templates and JSON data into social media images and PDFs,
so other tools can produce finished visuals through an API call instead of a
design editor.

Vocabulary is defined in [`CONTEXT.md`](./CONTEXT.md). Decisions live in
[`docs/adr/`](./docs/adr/).

## Run it

```bash
pnpm install
pnpm dev                 # server on :8787
pnpm demo                # render the full demo set into out/demo
npx tsx scripts/verify.ts out/demo   # prove no render came out blank
```

`scripts/prepare-assets.ts` re-imports brand logos and fonts from their sources.
Run it only when an upstream asset changes.

## API

Base URL: <https://meco-teal.vercel.app>. See [DEPLOY.md](DEPLOY.md).

Bearer auth applies to `/v1/*` when `MECO_TOKEN` is set, and is off when it is not.

| Endpoint | Does |
|---|---|
| `GET /` | demo console: pick a Template, fill the form, see the Render |
| `GET /health` | liveness, storage driver, template count |
| `GET /v1/templates` | every Template with its input contract as JSON Schema |
| `GET /v1/channels` | Channels and Placements with their pixel sizes |
| `GET /v1/brands` | brand tokens |
| `POST /v1/render` | render one Template at one or more Placements |
| `POST /v1/carousel` | render Slides into one multi-page PDF, or N images |
| `POST /v1/crop` | cut a Source Image to a shape by Crop Anchor |
| `POST /mcp` | the same operations as MCP tools, streamable HTTP |

`GET /v1/templates` is the point of the design: a calling tool reads it and
knows exactly what to send, without anyone documenting each new Template.

### Render

Naming a bare Channel renders every Placement it offers; naming
`instagram/story` renders exactly that one.

```bash
curl -X POST localhost:8787/v1/render -H 'content-type: application/json' -d '{
  "template": "laica-post",
  "channels": ["linkedin"],
  "data": {
    "title": "Viel gelernt bei der Innovationskonferenz",
    "date": "26. Juni 2026",
    "heroImage": "https://www.laica.dev/api/media/file/Astronaut-pitch.png"
  }
}'
```

Returns one entry per Placement, each with a stable URL. Renders are
content-addressed, so the same inputs return the same URL and a retry costs
nothing.

### Carousel

Each Slide names its own Template, so a carousel is a cover, some points and a
closing card rather than one layout repeated.

```bash
curl -X POST localhost:8787/v1/carousel -H 'content-type: application/json' -d '{
  "channel": "linkedin/post",
  "output": "pdf",
  "slides": [
    {"template":"laica-slide","data":{"kind":"cover","title":"Viele kleine Schritte"}},
    {"template":"laica-slide","data":{"kind":"point","index":1,"total":1,"title":"Marketing ist schwierig"}},
    {"template":"laica-slide","data":{"kind":"outro","title":"Schreib uns","cta":"Kontakt"}}
  ]
}'
```

## Templates

| Template | Brand | For |
|---|---|---|
| `laica-post` | laica | LinkedIn image for a Logbuch post |
| `laica-slide` | laica | one carousel slide: `cover`, `point`, `quote`, `outro` |
| `hopefamily-post` | Hope Family | blog post card built on the post header image |
| `swisshutless-race` | Swiss Hutless | race infographic for one championship round |
| `swisshutless-product` | Swiss Hutless | shop product post |

A Template is a design with no pixel size of its own; it adapts to whatever
Placement it is rendered for. Add one by writing the component and registering
it with a Zod schema in `src/templates/registry.ts` — the discovery endpoint
picks it up automatically.

## Demo console

<https://meco-teal.vercel.app> is a one-page console over the same `/v1/*`
endpoints — no separate render path, so what it shows is what a calling tool
gets. Paste `MECO_TOKEN` into the header field once; it stays in the browser.
The form is generated from each Template's JSON Schema and pre-filled from its
`example`, so a new Template appears in the UI with no UI change.

## Using it from Claude

`skills/meco/` is the skill that drives the MCP server from Claude Code and
Claude Desktop; [`skills/meco/SETUP.md`](skills/meco/SETUP.md) has the connector
setup for both. `zip -r meco-skill.zip meco` inside `skills/` produces the
upload Claude Desktop wants.

## How it renders

[Takumi](https://github.com/kane50613/takumi) — a Rust layout engine with no
browser, so a render is tens of milliseconds and the service stays one Node
process. Carousel PDFs are stitched from rendered PNGs with `pdf-lib`. Photo
cropping is `sharp`.

Storage picks itself from the environment: Vercel Blob when
`BLOB_READ_WRITE_TOKEN` is set, local disk under `out/` otherwise.

Deployment is in [`DEPLOY.md`](./DEPLOY.md).

## Verifying a change

`scripts/verify.ts` measures ink coverage — the share of pixels differing from
the dominant background, and how far down the canvas it spreads. Entropy would
be the obvious metric and is the wrong one: a deliberately flat, minimal slide
scores as low as an empty canvas.
