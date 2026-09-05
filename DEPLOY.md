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
7. A second Blob store, private, for People:
   ```
   vercel blob create-store meco-people --access private --yes
   vercel env add BLOB_PEOPLE_READ_WRITE_TOKEN production   # and preview
   ```
   The second command takes the new store's read/write token on stdin, under
   the name meco reads. `create-store` writes its own token into the project
   env under whatever name it picks, and the first store already holds
   `BLOB_READ_WRITE_TOKEN`. Set on `production` and `preview`; add it to
   `development` too if a local `vercel dev` needs to write a Reference Photo.

Vercel Blob sets public or private **per store, not per object**: a private
write to the public store is refused by the API. Everything under the `people/`
prefix — Person records, Reference Photos, Face Prints — is personal data and
belongs in the private store. Without `BLOB_PEOPLE_READ_WRITE_TOKEN` meco
refuses any write to that prefix rather than putting a face photo of a named
person on an open URL. Nothing else changes: `renders/`, `carousels/` and
`crops/` stay public.

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

Needs `.env.local` in the repo root and takes roughly ten minutes; not part of
the gate (`scripts/storage-contract.ts` carries the same note). Runs one
contract — write at a key, read the same bytes back, overwrite, delete, ask for
what is not there — against local disk and against Vercel Blob, and checks that
the Gallery never lists the People prefix. The Blob half needs
`BLOB_READ_WRITE_TOKEN` (it reads `.env.local` when there is one) and really
writes to the store, under a run-scoped `contract-test/` prefix it deletes
again. A missing token is a failure, not a skip: only one backend runs in
production, so an untested one is where a difference hides. The Blob delete
check polls for a few seconds rather than reading once — the CDN does not
promise a delete is visible on the very next read, only that it eventually is.

One check is skipped locally: that an unauthenticated GET of a Reference
Photo's URL does not return the bytes. There is no public URL to ask, because
the dev server mounts the three public kinds by name and the People prefix has
no route. On Blob the equivalent check runs and passes once
`BLOB_PEOPLE_READ_WRITE_TOKEN` is set — without it, both People checks skip and
name the missing variable.

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

The faces image is built from a root-level **`Containerfile`**, and the name is
forced from two sides. Each cost a failed deployment to find, so both errors are
here verbatim for whoever adds a third service.

**The `entrypoint` basename must be a Dockerfile or a Containerfile.** A
descriptive name is refused before anything is built:

```
Error: Container service "meco-faces" has invalid "entrypoint" "Dockerfile.faces".
It must name a Dockerfile or Containerfile.
```

**The build context is the entrypoint's own directory, and `root` is ignored.**
Moving the file to `packages/faces/Dockerfile.vercel` gets past the first check
and then cannot see the workspace lockfile:

```
Error: building at STEP "COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./":
checking on sources under "/vercel/path0/packages/faces":
copier: stat: "/pnpm-lock.yaml": no such file or directory

buildah build … -f /vercel/path0/packages/faces/Dockerfile.vercel /vercel/path0/packages/faces
```

That last line is the whole story: the directory at the end is the context, and
`"root": "."` did not change it. So the file has to sit at the repository root,
and its basename has to be one of the two Vercel accepts. `Dockerfile.vercel` is
meco's. A root-level `Containerfile` is what is left.

`MECO_TOKEN` must be set on both services. `POST /faces/detect`,
`POST /faces/embed` and `POST /faces/objects` require it; `GET /faces/health`
does not, so that a liveness probe does not need a secret.

### Telling meco where the faces are

**`FACES_URL` must be set on the meco service**, or meco never calls the face
service at all — no Crop is framed on a face and `POST /v1/subjects` answers 400
naming this variable. It is the single injection point on meco's side, which is
what lets one code path serve the rewrite, a second project and a laptop:

| Deployment | `FACES_URL` |
|---|---|
| Both services in this project | the deployment's own origin plus the prefix, e.g. `https://meco-teal.vercel.app/faces` |
| A separate `meco-faces` project | that project's origin, e.g. `https://meco-faces.vercel.app` |
| `docker run` locally | `http://localhost:8788` |

The first row goes back out through the platform and in again by the rewrite —
one extra hop, bounded by the rule that each Source Image is detected once. Left
unset, meco behaves exactly as it did before there was a face service; that is
the state every Crop test in `pnpm test:http` runs its non-face cases in.

Nothing else on meco's side is configurable: the detect timeout is a constant in
`src/faces.ts`, because a knob on a route only meco calls is a promise with no
one to keep it.

Annotations are filed at `annotations/<sha256-of-the-source-image>.json` in the
same store as Crops, public. They hold rectangles and landmark points, no
photograph and no name, and the Gallery does not list them — an Annotation is a
record, not a stored output.

`POST /faces/detect` takes the image bytes as the body and answers

```
{ "width": 1120, "height": 1400,
  "faces": [ { "box": { "x": 0.4795, "y": 0.1734, "width": 0.0789, "height": 0.0858 },
               "landmarks": { "rEye": {…}, "lEye": {…}, "nose": {…},
                              "rMouth": {…}, "lMouth": {…} },
               "score": 0.934 } ] }
```

every number a fraction of the image. The box is spelled the way `SubjectBox` in
`src/crop-solver.ts` is spelled, so a face needs no rename on its way into the
solver.

`POST /faces/embed` takes the same image bytes as the body and the faces
`/detect` returned as a query parameter, and answers one Face Print per face, in
the order they were given:

```
POST /faces/embed?faces=<url-encoded JSON array of the faces from /detect>

{ "prints": [ [ 0.0271, -0.0483, … 512 floats … ] ] }
```

Only `landmarks` is read; the box and the score are ignored, because ArcFace
alignment is defined by the five points alone. Each Face Print is L2-normalised,
so comparing two is a dot product. No identity is returned — matching a Face
Print to a Person happens in meco, against a gallery this service cannot see.

`POST /faces/objects` takes the image bytes as the body and answers what it saw
that is not a face, in the vocabulary its model was trained with:

```
{ "width": 600, "height": 400,
  "objects": [ { "label": "motorbike", "score": 0.849,
                 "box": { "x": 0.1409, "y": 0.4157, "width": 0.5883, "height": 0.3622 } },
               { "label": "person", "score": 0.711,
                 "box": { "x": 0.3506, "y": 0.2578, "width": 0.2131, "height": 0.3588 } } ] }
```

fractions again, and the same box spelling. **`motorbike` is a kart**, and that
is not a bug to fix: COCO has no kart class, so the model resolves one to the
nearest thing in its vocabulary, and measured on 32 on-track photographs that
approximation finds the kart on 29 of them while the face detector finds the
driver's head on 9. The word is wrong and the box is right.

The class index the model uses internally is deliberately **not** on the wire.
It is D-FINE's own numbering; a caller reading it would be pinned to this
model's label ordering rather than to its vocabulary, and it cannot survive an
Annotation, which stores the word.

Deciding that a `motorbike` and the `person` sitting on it are one Subject is
framing policy, so it lives in meco — `kartSubjectBox` in `src/crop.ts` — where
it is arithmetic that `pnpm test:crop` drives with no service and no image.

### Measured

| | |
|---|---|
| Image, `linux/amd64` | **143.4 MB**, against **129.4 MB** for the same build with the object model taken out |
| Image, delta for embed | **+7 MB** on disk, **+6 MB** in the registry — the EdgeFace model and nothing else |
| Image, delta for objects | **+14.0 MB**, or +10.8 % — the D-FINE model and nothing else |
| Detection model | `face_detection_yunet_2026may.onnx`, 229,738 B, MIT, copied in at build time |
| Recognition model | `edgeface_xs_gamma_06.onnx`, 7,277,244 B, weights CC BY-NC-SA 4.0, copied in at build time |
| Object model | `dfine_n_coco.onnx`, 15,434,935 B, Apache-2.0 — see `models/LICENCE-dfine.txt`, which is also the attribution — copied in at build time |
| Cold, 12 MP photo | **~450 ms** from `docker run` to a served detection; 351–491 ms over five boots, unchanged by the third model |
| Cold to a served object detection | **~670 ms**; 617–788 ms over five boots |
| Warm detect, 12 MP photo | **~50 ms** median |
| Warm embed, 12 MP photo, one face | **~53 ms** median |
| Warm embed, 12 MP photo, four faces | **~85 ms** median |
| Warm objects, 12 MP photo | **~130 ms** median, and 175 ms on a machine also building images |
| Marginal cost of a further face | **10–18 ms** — one warp and one row of a batched inference |

The image size is the `linux/amd64` build, which is what Vercel runs, and both
figures come from `docker image inspect --format '{{.Size}}'` on this machine —
the delta is the honest number, since that reading is not the 377 MB an earlier
Docker reported for the same content. Reproduce the delta by building twice,
once with `packages/faces/models/dfine_n_coco.onnx` moved aside.

The latency figures are local Docker on Apple silicon (`linux/arm64`), against
the real image, and they are the service's own cost. Reproduce with:

```
docker build -f Containerfile -t meco-faces .
MECO_TOKEN=local-token pnpm --filter meco-faces exec tsx scripts/latency.ts \
  http://localhost:8788 12 -- \
  docker run --rm --name faces-lat -p 8788:80 -e PORT=80 -e MECO_TOKEN=local-token meco-faces
docker rm -f faces-lat
```

The 12 MP photo is the four-face fixture enlarged to 3000×4000 at run time. What
is being timed is a decode and a fixed-size resize, and neither cares whether
the detail is real. Every round embeds one face and then all four of them on
that same photograph, which is what makes a face's own cost measurable: both
calls pay the same decode, so the gap between the two medians is the marginal
cost and the script prints it.

**Embedding is mostly the decode.** Roughly 52 ms of an embed is reading 12 MP
of JPEG and the round trip, and about 10 ms is each face's warp and its row of
the inference. That is why `/embed` takes the whole image again rather than a
crop of it, and why the faces go in one batched call rather than one call each.

**So is object detection, and by a wider margin.** The 129 ms above is a 12 MP
JPEG, and the model is the small part of it. Measured in-process on a 1400×875
photograph, medians over 20 warm runs: **sharp decode and resize 10.5 ms,
inference 28.6 ms, the TypeScript decode of 300 queries under 0.05 ms**, with the
ORT session costing **143 ms** to create once. The research measured 27 ms on the
same model outside a container, so this reproduces it. What grows the number to
130 ms is decoding twelve megapixels, not looking at them —
D-FINE stretches whatever it is handed into one 640×640 square and always emits
exactly 300 queries, so its own cost does not depend on the picture at all.

**fp32, and not a quantised build.** A q4f16 export of this model exists at
5,966,346 B, a third of the size. It was measured and rejected: 64 ms warm
against 28 ms — **2.3× slower** — while also finding four fewer karts and two
fewer drivers across the 32-photograph set. The same trap the research recorded
for MoveNet, where int8 measured 31.83 ms against fp32's 14.41 ms. Quantisation
is not a free size saving on this runtime; measure before assuming otherwise.

**Which export, and why it is not the obvious one.** The weights come from
`AnnotateIt/dfine-nano-coco-onnx`, not from `onnx-community/dfine_n_coco-ONNX`,
which is the repository the research first measured. Two reasons, and the second
is the one that changes what a Crop does:

- onnx-community declares **no licence at all** — no card metadata, no tag, no
  `LICENSE` file — so it states no terms and cannot discharge Apache-2.0
  section 4 on anyone's behalf. AnnotateIt's declares `apache-2.0`, ships the
  licence text, and publishes the source checkpoint's revision and SHA-256.
- Its export is dated 2025-04-30. The checkpoint it converts was **corrected on
  2025-08-20** in a commit titled "Fix weights", so it converts superseded
  weights. Re-measured across the research's 32 photographs, that costs 8 of 29
  usable kart-and-driver boxes and roughly half the confidence — typical scores
  move from the 0.28–0.55 band to 0.66–0.90, at the same speed and +176,577 B.

`models/LICENCE-dfine.txt` records the whole chain and
`scripts/verify-dfine.ts` re-checks it, including that no newer commit has
landed on the weights since.

**The third model does not slow the face path.** Cold to a served *detection* is
unchanged, because the sessions are created lazily and `/detect` never touches
D-FINE. Cold to a served *object detection* is roughly 220 ms more, which is
that session create plus the noise of a laptop. Both are well inside the 1.5 s
cold budget the plan set.

**The cold start.** Boots of the detect-only image on this machine measured
400–592 ms; this image measures 381–586 ms, so recognition is inside the noise.
It is only there because the two model sessions are created one after the other
rather than together — starting them concurrently costs the detector around
400 ms on a cold boot, and a cold boot is always woken by a detection, since
nobody can ask for a Face Print before they know where the face is. Every
latency figure here swings 30–50 % run to run on a laptop that is also building
images; take the medians, not the extremes.

**Against a deployment the same request takes about 1.1 s**, measured on a
preview from Switzerland to `cle1`: 1420 ms first, 1068 ms median over twelve
runs. That number is not the detector. A 0.2 MB photo takes the same 0.75–2.3 s
as the 1.1 MB one, so what is being measured is the round trip and Vercel's
routing, which is why the table above is the local one. Point the same script at
a deployment when you want the number a caller in another region actually sees:

```
MECO_TOKEN=<preview token> pnpm --filter meco-faces exec tsx scripts/latency.ts \
  https://<deployment>.vercel.app/faces 12
```

### What meco sends

meco bounds a Source Image to a **1600 px long edge and 4 MB** before `/detect`,
`/embed` or `/objects` sees it — `LONG_EDGE` and `MAX_BYTES` in `src/faces.ts`. A
photograph inside both is passed through untouched, byte for byte; anything
outside either is resized (never enlarged) and re-encoded as JPEG at quality 90.
Two bounds because a long edge is not a body size and the platform refuses on the
body size: 1600x1600 of random noise is 7.7 MB as a PNG, and a screenshot or a
scan reaches that far more plausibly than a photograph does. The worst case out
of the re-encoder is 2.1 MB — that same noise — so the invariant holds by
construction rather than by luck of the fixtures.

This is not a tuning knob. A Vercel Function refuses a request body over 4.5 MB,
and the rewrite that fronts this container is a Function, so a photograph over
roughly 4.5 MB never reached the service at all: it came back
`413 FUNCTION_PAYLOAD_TOO_LARGE`, the Crop fell back to `centre`, and Face Blur
and Person matching went quietly unavailable. A 12 MP photograph off a phone is
5–8 MB, so that was the ordinary case (issue #30).

What the bound costs, measured on `fixtures/faces/artemis-2-crew-full.jpg` — the
group photograph at the 5878x7348 and 5 424 279 bytes Commons serves it, four
faces at four scales. Every row of this table is printed by `pnpm test:detect`
and `pnpm test:embed`, pass or fail:

| Long edge sent | Bytes | Worst box off the hand-marked one | Worst box moved from the full-size detection | Worst Face Print cosine against its own full-size print |
|---|---|---|---|---|
| full size, 7348 | 5.42 MB | 0.0113 | — | — |
| 2048 | 0.56 MB | 0.0117 | 0.0009 | 0.9677 |
| **1600** | **0.36 MB** | **0.0116** | **0.0019** | **0.9644** |
| 1280 | 0.25 MB | 0.0115 | 0.0008 | 0.9593 |
| 640 | 0.08 MB | 0.0113 | 0.0004 | — |

Landmarks are measured beside the boxes and move no further: 0.0035 at worst, at
1600 px. They are checked separately because they come out of a different head of
the network, and a box can sit still while an eye drifts.

Read it as three separate claims:

- **Detection cannot tell.** The tolerance the hand-marked boxes are judged
  against is 0.03, and no box moves as much as 0.002 between full size and any
  long edge down to 640. That is expected rather than lucky: YuNet is fed a
  640 px long edge whatever it is handed, so everything above that is thrown
  away inside the service anyway. Detect also gets faster — about 70 ms to about
  13 ms on this photograph, most of it the decode; the suite prints both, and on
  a laptop that is also building things they swing.
- **Embedding does move, and it does not matter.** A Face Print off the bounded
  copy is 0.96 cosine to the print off the full-size photograph, because the warp
  reads real pixels of the face: at 1600 px the smallest of these four faces is
  ~100 px across, just under the 112 px template. Identity survives it, and the
  suite states that as a margin rather than as a cosine — each print stays nearer
  its own full-size print than any other face's, 0.96 against 0.26.
- **Nothing needs remapping.** Both routes answer in fractions of the image, and
  a fraction does not change with resolution. The one number that does is the
  size, so `detectFaces` reports the photograph's own size rather than the size it
  sent — which is what the console outlines a face in, and what an Annotation
  records. `MIN_FACE_PX` in `src/people.ts` goes the other way and is measured in
  the copy, because it is the copy that gets upsampled into the network.

`pnpm test:http` holds the other half: its stand-in enforces the same 4.5 MB the
platform does, so the boundary that hid this bug is now inside a suite. Reverting
either bound turns it red with the verbatim production failure.

**Two numbers here are not reproducible from the repository**, because they need
the full-size Commons files of all four fixture photographs and only the group
one is committed. Both were measured once, by detecting and embedding each
photograph at full size and again at a 1600 px long edge:

- The **worst same-person cosine goes 0.7146 to 0.7117** and the **best
  different-person cosine 0.2985 to 0.2979**, against a `MATCH_THRESHOLD` of 0.5
  in `src/people.ts` — a gap of 0.42 that the bound moves by 0.003. That is the
  measurement the bound rests on, and it is the reason `/embed` is given the same
  bounded photograph rather than a tighter full-resolution crop around each face:
  the crop scores 0.999 against the full-size print instead of 0.96, and buys
  nothing that a Match can see.
- The print **holds to 0.79 at a 320 px long edge and collapses to 0.34 at 160**,
  which is where the headroom below 1600 comes from. Redo that one by adding 320
  and 160 to the long edges in the bound section of `packages/faces/scripts/embed-test.ts`.

Raising the platform cap was not pursued. Sending 5 MB over the rewrite so a
detector can look at a 640 px grid is waste even where it is allowed.

### Prove the detector still finds faces

```
pnpm test:detect
```

Runs `POST /detect` in-process over three public-domain photographs — four
faces, one face, none — and fails if a box moves more than 3 % of the image away
from the hand-marked one in `fixtures/faces/expected.json`. It also detects the
full-size original of the group photograph at four long edges, which is what
holds the bound above honest, checks that an unauthenticated request is refused,
and that `/health` names the model and the ONNX Runtime version.

### Prove the object detector still finds a kart

```
pnpm test:objects
```

Two halves, and the first is the one that matters. D-FINE's published export
stops at raw logits and normalised `cxcywh` boxes, so about forty lines of
decode stand between the graph and an answer — and every ordinary mistake in
them still returns plausible rectangles on a photograph of a kart. A missing
sigmoid keeps the ranking and only moves the threshold; a centre read as a
corner shifts every box by half its own size; class-agnostic suppression deletes
the driver and leaves the kart. So `decodeDfine` is driven with tensors written
by hand and answers worked out on paper, and only then is the real model run
over the six photographs in `fixtures/karts/`, against boxes that were rendered
over them and looked at.

All three of those mistakes were made deliberately and the suite caught each. So
were both preprocessing traps: applying the ImageNet mean and standard deviation
that `preprocessor_config.json` lists but sets `do_normalize: false` for finds
**nothing at all** on the headline fixture, and letterboxing instead of
stretching moves every box.

### Re-verify the object model against its source

```
pnpm --filter meco-faces exec tsx scripts/verify-dfine.ts
```

Not in the gate, because it reaches the network. It re-downloads nothing but the
metadata and checks the committed weights against the record in
`packages/faces/models/LICENCE-dfine.txt`: the byte count, the SHA-256, that the
pinned Hugging Face revision still serves those bytes, that the artefact still
declares `apache-2.0` **and ships the licence text**, that the checkpoint it
converts still declares it too, that the export still pins the fixed revision of
those weights and that **no newer commit has landed on them since**, that
preprocessing is still rescale-only with no normalisation, that `COCO_LABELS` is
still the model's own `id2label` in its order, and that the graph still hands
back raw logits rather than probabilities.

The revision checks are the point rather than a formality. The export this
repository first reached for was built four months before its own base
checkpoint was fixed, and no licence check and no graph check would have
noticed — only the dates did. Run this when the weights change, when the licence
record is questioned, or before a release that ships them.

### Prove a Face Print still means what it meant

```
pnpm test:embed
```

Checks the four things that can be wrong with an embedder without anything
throwing.

- **The warp.** Five landmarks are placed by a known similarity transform, drawn
  as markers, aligned, and their centroids measured in the 112×112 square. The
  arrangement is the template's own, so the fit has no residual and the eyes
  must land on `arcface_dst` exactly. Measured: every landmark within 0.15 px,
  the eyes within 0.05 px. A second case does the same on a real detected face,
  where the fit does leave a residual, and checks the markers against the
  transform's own prediction instead: within 0.19 px.
- **The export.** Face Prints computed through the whole service path are
  compared with the Face Prints PyTorch produced, committed in
  `fixtures/faces/edgeface-reference.json`. Measured: cosine 1.000000 on all
  nine fixture faces, against a floor of 0.99.
- **The meaning.** The same person in three photographs — two portraits four
  years apart and a launch-pad group shot — scores **0.8689**, **0.8182** and
  **0.7304**; the worst of the thirty-three different-people pairs scores
  **0.2855**. Those are a sanity floor and not an operating point; the operating
  point is the next section.
- **The committed Face Prints.** `fixtures/faces/face-prints.json` is what the
  match calibration sweeps, and meco cannot recompute it — the embedder is in
  this package. So this test re-embeds every fixture face and fails on any
  difference at all. A stale file would otherwise fail nowhere and calibrate a
  threshold against numbers no deployed model produces.
- **The bound.** A Face Print off the group original bounded to 2048, 1600 and
  1280 px has to stay nearer its own full-size print than any other face's, by a
  wide margin. That is what licenses `LONG_EDGE` in `src/faces.ts`; the numbers
  are in **What meco sends** above.

### Prove no stranger is given a name

```
pnpm test:match
```

Sweeps the match threshold over every fixture face against every gallery and
fails on a single **false Match** — a stranger named, or one Person named as
another. That is the failure that matters: not a wrong number in a log, but the
wrong person's face left sharp in a published post. A *missed* Match is reported
and does not fail the run.

The shipped operating point is **threshold 0.50, margin 0.05**, and every value
from 0.30 to 0.80 decides all 66 trials correctly. Where the numbers came from,
what the margin is worth, and when both have to be earned again are in
[`docs/adr/0003-face-recognition-licence-consent-and-threshold.md`](docs/adr/0003-face-recognition-licence-consent-and-threshold.md).
The short version: **calibrated on the committed fixture photographs, not on
anyone meco has enrolled, because nobody is enrolled yet.**

It needs no model and no network — it reads `fixtures/faces/face-prints.json`
and calls the same `matchFacePrint` the service calls.

### Change the recognition model

`packages/faces/models/edgeface_xs_gamma_06.onnx` is committed, and
`packages/faces/scripts/export-edgeface.py` is the only thing that may write it.
It pins `otroshi/edgeface` at commit `ce86851c` and the checkpoint's SHA-256, and
refuses to finish unless its own ONNX output still matches PyTorch.

PyTorch has no wheels for every Python — 3.14 is not supported — so the export
needs a pinned interpreter. Nothing else in the repository does; there is no
Python in the image, the tests or CI.

```
uv venv --python 3.12 .temp/edgeface-venv
uv pip install --python .temp/edgeface-venv/bin/python \
  torch torchvision timm onnx onnxruntime numpy pillow
pnpm --filter meco-faces dump:aligned          # the aligned squares, from the real warp
.temp/edgeface-venv/bin/python packages/faces/scripts/export-edgeface.py
pnpm --filter meco-faces dump:prints           # the Face Prints the match sweep reads
```

Run the three in that order. The first writes `fixtures/faces/aligned/`, the
second embeds exactly those pixels — which is what makes the committed reference
a statement about the input meco-faces really sends — and the third rewrites
`fixtures/faces/face-prints.json` so the match calibration is sweeping the new
model rather than the old one.

**Changing the recognition model invalidates every stored Face Print.** A print
from one network means nothing against a print from another, and a stored print
carries no model tag to notice by — see ADR-0003. There is no migration that
reads the old prints. The Reference Photos are still in the private store, so
the path is to enrol them again, and it is the only path.

### Test locally

```
docker build -f Containerfile -t meco-faces .
docker run --rm -p 8788:80 -e PORT=80 -e MECO_TOKEN=<token> meco-faces
curl http://localhost:8788/health
curl -X POST http://localhost:8788/detect \
  -H "authorization: Bearer <token>" \
  --data-binary @fixtures/faces/astronaut-portrait.jpg
```

`/embed` needs the faces alongside the bytes, so it is easier from the latency
script — which now times a detect and an embed on every round — than from
`curl`:

```
MECO_TOKEN=<token> pnpm --filter meco-faces exec tsx scripts/latency.ts \
  http://localhost:8788 12
```

## People

Reference Photos and Face Prints are personal data. Three rules, and the code
holds all three:

- **Nothing about a Person leaves the People prefix.** Everything lives under
  `people/<brand>/<personId>/`, which routes to the private Blob store and is
  never listed by the Gallery. Enrolling writes no Annotation, so a Reference
  Photo leaves no trace under `annotations/` either.
- **A Reference Photo has no public URL.** `GET /v1/people/:id/photos/:photoId`
  serves the bytes, behind the same token as the rest of `/v1/*` and marked
  `private, no-store`. No answer about a Person carries a storage URL.
- **Deleting a Person deletes everything.** `DELETE /v1/people/:id?brand=` lists
  the Person's own prefix and removes what is there, rather than working from
  the record's list of photographs — a half-finished enrolment must not be able
  to leave bytes behind. This is the deletion path to point a data subject at.

Consent is recorded, not assumed: the console has a checkbox at enrol time and
the answer is stored as `consentAt` on the photograph. Absent means nobody said
so. Only enrol people who agreed — a licence to republish a photograph is not
the subject's agreement to be recognised by software, and the two are different
permissions. The rule and the reasoning are
[ADR-0003](docs/adr/0003-face-recognition-licence-consent-and-threshold.md),
which also records that the EdgeFace weights are CC BY-NC-SA and why that is an
accepted risk rather than an oversight.

Uploads go to `POST /v1/people/:id/photos`, as multipart (several files at once)
or as a JSON body naming a URL. **The platform caps a request body at 100 MB**
and meco does not narrow that: a second, smaller limit here would refuse
photographs the platform would have carried. A request that is too large is
refused by Vercel before it reaches meco.

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
