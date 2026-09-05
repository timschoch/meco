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

Auth applies to `/v1/*` and `/mcp` when `MECO_TOKEN` is set, and is off when it
is not. Send it as `Authorization: Bearer <token>` or, for clients that cannot
set that header, `x-auth-token: <token>`.

| Endpoint | Does |
|---|---|
| `GET /` | demo console: pick a Template, fill the form, see the Render; a Gallery tab lists what is stored |
| `GET /health` | liveness, storage driver, template count |
| `GET /v1/templates` | every Template with its input contract as JSON Schema |
| `GET /v1/channels` | Channels and Placements with their pixel sizes |
| `GET /v1/brands` | brand tokens |
| `GET /v1/gallery` | every stored Render, Carousel and Crop, newest first; `?brand=` and `?placement=` filter |
| `POST /v1/render` | render one Template at one or more Placements |
| `POST /v1/carousel` | render Slides into one multi-page PDF, or N images |
| `POST /v1/crop` | cut a Source Image to a shape; a solver frames it and the answer names what decided — `person`, `face`, `saliency`, `anchor` or `centre` — a `subjectArea` says where in the result the Subject has to land, and a `brand` lets a recognised Person take the frame while `blurUnknownFaces` hides everyone else |
| `POST /v1/subjects` | the Annotation for a Source Image — every face as a rectangle — without cropping it; with a `brand`, also which of them are People it has enrolled |
| `GET /v1/people?brand=` | the People a Brand has enrolled, with their Reference Photos |
| `POST /v1/people` | create a Person under a Brand |
| `DELETE /v1/people/:id?brand=` | remove a Person and every Reference Photo and Face Print of them |
| `POST /v1/people/:id/photos` | enrol Reference Photos: multipart (several files at once) or a JSON body naming a URL |
| `GET /v1/people/:id/photos/:photoId?brand=` | the bytes of one Reference Photo — private, token only |
| `DELETE /v1/people/:id/photos/:photoId?brand=` | remove one Reference Photo and its Face Print |
| `POST /mcp` | the same operations as MCP tools, streamable HTTP |
| `POST /mcp/<token>` | the same, for clients that treat a 401 as a reason to start OAuth |

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

### Crop

A face in the Source Image frames the Crop by itself: the largest face wins the
anchor, its eye line goes on the upper golden line, and the other faces are kept
in frame while the shape allows it. Nothing has to be asked for — set `FACES_URL`
and every Crop is framed that way, falling back to `strategy`, `anchor` and the
centre when there is no face, no answer from the face service, or no face service
at all. The answer names what decided in `resolvedBy`, and carries `warnings`
when the faces could not be looked for.

Each Source Image is analysed once. meco hashes the bytes, keeps the Annotation
under that hash, and only calls the face service on a miss — so ten Placements of
one photograph cost one detection. `POST /v1/subjects` hands that Annotation over
on its own, which is what the console's "Preview subjects" button draws.

Name a `brand` and meco also tries to recognise that Brand's People. A face is a
**Match** only when it clears an absolute similarity threshold *and* beats the
second-best Person by a margin — so "nobody" is a valid answer and, in any
photograph with a stranger in it, the usual one. A Match wins the anchor whatever
size the face is, `resolvedBy` says `person`, and the answer lists every Match by
name and score. `persons` limits which People may be recognised; `pinTo` chooses
between `person`, `faces` and `attention`. A Person belongs to exactly one Brand
and is never matched for another.

`blurUnknownFaces` then hides every face that is **not** a Match, behind an
elliptical mask, and says how many in `blurred`. Without a `brand` there are no
Matches, so it hides all of them.

Some faces meco cannot ask about at all — the alignment refuses a face too small
or too turned to warp, and the face service can fail outright. Those are
**Uncompared Faces**, counted in `facesNotCompared` whenever a `brand` was named,
zero and all. They are never a Match, so `blurUnknownFaces` hides them like any
other face meco cannot name, and they stay in the Annotation as Subject Boxes.
The count is there because "nobody in this photograph is enrolled" and "meco
could not look at one of these faces" otherwise arrive as the same empty
`matches`.

Where the threshold and the margin came from, and what they are worth, is
[ADR-0003](docs/adr/0003-face-recognition-licence-consent-and-threshold.md).

A `subjectArea` says which rectangle of the result the Subject has to fill, as
fractions from the top-left. Without one the solver uses its golden-ratio grid.
The answer carries `subjectAreaSatisfied`.

How much the area can do depends on what the framing knows about the Subject.
Saliency, Crop Anchor and centre each yield a point rather than a region, and a
point cannot fill anything, so the area aims the framing without setting the
zoom. A face is a real rectangle, so with one the zoom is solved from the area as
well — and a Source Image too small to fill the area at that shape is refused
with a 400 naming the window it would have needed.

```bash
curl -X POST localhost:8787/v1/crop -H 'content-type: application/json' -d '{
  "source": "https://example.com/photo.jpg",
  "width": 1080,
  "height": 1350,
  "strategy": "attention",
  "subjectArea": {"x":0.3,"y":0.15,"width":0.4,"height":0.5}
}'
```

### People

A Brand can enrol the People it wants recognised. Create a Person by name, then
add Reference Photos — several at once as a multipart upload, or one at a time by
URL. meco finds the faces: one face enrols by itself, several come back as a list
for the caller to choose from with `faceIndex`, and a photograph with no face, or
a face under 40 px, is refused. A `faceIndex` may only accompany a single
photograph — an index means something different in every picture — so the answer
to "which face?" is that photograph sent again on its own.

Each photograph in a batch is judged on its own, so one unusable file does not
throw away the ones beside it; the request is a 400 only when nothing in it could
succeed. The Face Print is computed by meco-faces and
stored beside the photograph, with a consent timestamp when the caller says the
Person agreed.

```bash
curl -X POST localhost:8787/v1/people -H 'content-type: application/json' \
  -d '{"brand":"laica","name":"Ada Lovelace"}'

curl -X POST localhost:8787/v1/people/<id>/photos \
  -F brand=laica -F consent=true -F file=@portrait.jpg -F file=@second.jpg
```

Every Person route names the Brand, because a Person belongs to exactly one and
the record is filed under it. Reference Photos and Face Prints are personal data:
they live in a private store, never appear in the Gallery, have no public URL,
and go away entirely when the Person does. See [DEPLOY.md](DEPLOY.md#people).

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

`pnpm test:ui` runs the page in jsdom against a stubbed API and drives all three
tabs. Browser-only bugs — a read-only DOM property, a form field read back in the
wrong shape — are invisible to a render test, and this is what catches them.

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

| Script | Proves |
|---|---|
| `pnpm test:crop` | the crop solver puts a Subject on a golden line, and names the fallback when it cannot |
| `pnpm test:match` | no stranger is ever given a Person's name, at the shipped threshold and margin |
| `pnpm test:http` | the HTTP API in-process: crop and Gallery against a temp directory, no port and no network |
| `pnpm test:mcp` | every MCP exchange over `/mcp` ends instead of holding the container open |
| `pnpm test:ui` | the demo console in jsdom, every tab clicked |
