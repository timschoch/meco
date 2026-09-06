# Spec: the models module

Parent: [Module: models (#83)](https://github.com/timschoch/meco/issues/83). Settles [The models adapter contract and its conformance suite (#75)](https://github.com/timschoch/meco/issues/75). Reasons: [ADR-0007](../adr/0007-models-one-route-two-stage-catalogue.md). Vocabulary: [`CONTEXT.md`, models](../../CONTEXT.md#models). Shared types: [`docs/specs/contracts.md`](contracts.md). Deploy shape: [`DEPLOY.md`](../../DEPLOY.md).

## Problem statement

Eight modules want to know what is in a photograph and none of them should own a neural network. The prototype answered with three routes on a face service, each decoding the image again, each with its own response shape, and a caller that had to bound the image before sending because the platform refused the body. A model swap changed a route name; a new model was a new route.

## Solution

One container, one route. `POST /annotate` takes the Source Image's bytes and answers with the contracts Annotation. Inside, a Catalogue of Model Adapters: Detectors draw Regions from one Decoded Image, Enrichers add to them, and contracts numbers the result. A model enters the Catalogue by adding a folder with its adapter, its weights and its licence text, and by passing the same Conformance Checks as every other. The gateway talks to it through a typed client that knows the wire and nothing about ONNX.

## User stories

1. As the gateway, I want to post a Source Image's bytes once and get back one Annotation, so that I file it under its Content Hash and never call twice for the same photograph.
2. As the gateway, I want to name which Models run, so that a portrait does not pay for a vehicle detector and a kart photograph does not pay for a face print.
3. As the gateway, I want a typed client whose errors say what went wrong (undecodable, too large, unknown model, model unavailable), so that I map them to caller-facing answers without parsing strings.
4. As the gateway, I want the Annotation's `hash` to be the sha256 of exactly the bytes I sent, so that my cache key and the models service's answer can never disagree.
5. As the frame module, I want face, person and vehicle Regions in fractions with the Model's own Label, so that I compose Subject Boxes from them without knowing which network ran.
6. As the identify module, I want every face Region that could be aligned to carry a Face Print (`facePrint`, contracts' `FacePrint`) tagged with its Model, so that I compare like with like and know which faces were never printed.
7. As the redact module, I want a face Region for every face the detector saw, printed or not, so that Face Blur hides strangers the print could not name.
8. As the records module, I want `producedBy` to list every Model that ran with its version, so that a cached Annotation from an older adapter is a miss and not a wrong answer.
9. As an adapter author, I want one folder to add and one suite to pass, so that a new model lands in one PR that is refused when the licence text is missing.
10. As an adapter author, I want a test that fails when I swap the weights without bumping the version, so that the versioning rule is enforced by structure and not by memory.
11. As the operator, I want `GET /health` to say which Models are Warm on the instance that answered and how much memory it holds, so that a cold start or a leak is visible without a profiler.
12. As the operator, I want `GET /models` to list the Catalogue with each Model's licence, so that what ships is readable without opening the image.
13. As the operator, I want a probe I can point at any deployment that posts a fixture and prints the Annotation and the timing, so that every ticket is verified against the running system.
14. As the webui, I want the Catalogue and the per-request timing available, so that the what-happened view can show which Models looked and how long each took.
15. As a future adapter author, I want the host to decode once and hand every adapter the same pixels, so that I write preprocessing for my network and never an image decoder.
16. As the orchestrator, I want the models container to hold no Brand, Person, template or store credential, so that the only thing it can leak is geometry.

## Implementation decisions

### The wire

| Route                       | In                                                                                                    | Out                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `POST /annotate?models=a,b` | body: the Source Image bytes; `models` optional, default every Detector and Enricher in the Catalogue | 200 contracts `Annotation`; `Server-Timing` header                              |
| `GET /models`               | –                                                                                                     | the Catalogue: `{ name, version, kinds, licence, warm }[]`                      |
| `GET /health`               | –                                                                                                     | `{ ok, service, version, models: { name, version, warm }[], onnxruntime, rss }` |

- Bytes in the body, not multipart, not JSON, not a store key. The body is always exactly one photograph and the gateway holds the bytes when it hashes them. A store key would make the container hold a store token.
- `hash` is the sha256 of the body as received. The host never re-encodes before hashing. The client may pass the hash it computed and refuses an Annotation whose `hash` differs.
- `width`, `height` are the Source Image's after EXIF orientation, read from metadata, not from the Decoded Image.
- `mime` is what the decoder identified, not the request header. A format outside contracts' closed set is refused.
- Errors are `{ error: { code, message } }`. Codes and statuses: `empty_body` 400, `undecodable` 400 (sharp cannot read it), `unknown_model` 400 (a name not in the Catalogue; nothing is fetched), `bad_models` 400 (empty list or duplicate), `unsupported_mime` 415 (decoded format outside contracts' closed set), `too_large` 413 (body above 32 MB, checked on `Content-Length` and on the stream; a guard against a runaway body, not a photograph bound), `model_unavailable` 503 (a session failed to create on this instance; the memo is dropped so the next request retries), `internal` 500.
- `?models=` absent: every Catalogue entry runs. Present: exactly those, in Catalogue order. An Enricher named without the Detector whose kind it serves runs and enriches nothing; `producedBy` still lists it, so the cache records that it looked. The Detector is never implied: that would hide a cost the caller did not ask for.
- No token between gateway and models. The binding grants access; the container has no public rewrite. Ticket 1 confirms from outside Vercel that the models service answers nothing without the binding (the deployment's own URL for the service, and any hostname the binding value leaks); if it does answer, a shared `MODELS_TOKEN` applies at once. Reopen trigger either way: a second caller or a public route.
- Open measurement: whether a binding call is subject to the platform's 4.5 MB body limit. The first ticket posts a 6 MB fixture through the deployed gateway and records the answer here. If it bites, a `{ key }` JSON body becomes ticket 2, which is the one reason `annotate` accepts a body type and not a `Uint8Array` on the wire.

### The client

`@meco/models` root entry `index.ts`, imported by the gateway. It imports `@meco/contracts`, zod and the wire schemas only; a dependency-cruiser rule refuses `onnxruntime-node`, `sharp` and any host file from it, so no server code crosses into the gateway image. The layering rule `services-do-not-import-each-other` is amended to allow this one file, with that thin-client rule beside it.

- `createModelsClient({ baseUrl, fetch?, timeoutMs? })` → `{ annotate(bytes, { models?, hash? }), catalogue(), health() }`. Default `timeoutMs` 30 s: a cold instance creating three sessions must fit.
- `annotate` parses the response with contracts' `Annotation` schema; a body that does not parse is a `ModelsError` with code `bad_response`. When `hash` is given, an Annotation whose `hash` differs is refused as `hash_mismatch`. The gateway always passes the hash it filed the request under: two hashes of one body agreeing is the cheapest end-to-end proof that the wire carried the bytes intact.
- `ModelsError` carries `code` (the wire codes above plus `unreachable`, `timeout`, `bad_response`, `hash_mismatch`) and `status`.
- `catalogue()` returns `{ name, version, kinds, licence, warm }[]`, licence as its id; the text stays in the repo and the image.

### Entry points

Four root files, per [`packages/README.md`](../../packages/README.md). `index.ts`: the client, the only file the gateway imports. `app.ts`: `createApp(catalogue)`, the HTTP surface without a socket, for the HTTP tests. `catalogue.ts`: the real Detectors and Enrichers, the `Enricher` interface, `enricherConformance`, for the adapter tests. `server.ts`: the process; binds the socket, then warms the Catalogue. Everything else is under `lib/`, private.

### The host

`app.ts` builds the Hono app from a Catalogue, so a test can hand it in-memory adapters; `server.ts` binds the socket, then warms the real Catalogue.

- **Decode once.** sharp: EXIF rotate, resize to the Decode Bound (1600 px long edge, `fit: inside`, never enlarge), drop alpha, raw RGB → contracts' `DecodedImage`. JPEG uses shrink-on-load, so a 12 MP photograph never materialises at full size.
- **Why 1600.** Prototype measurements on the 5878x7348 group fixture (`fixtures/faces/artemis-2-crew-full.jpg`, `DEPLOY.md` history, 5 Sep 2026): no detection box moves 0.002 between full size and any cap down to 640; the smallest face is ~100 px at 1600, so its print moves (0.96 cosine against full size) but identity does not (worst same-person 0.7146 → 0.7117, best different-person 0.2985 → 0.2979); ADR-0003's threshold was calibrated at this size. Working memory: 1600 x 1600 x 3 = 7.7 MB per request.
- **Two stages.** Detectors run first, sequentially, each over the same Decoded Image; Enrichers run second over the union; `assignRegionIds` from contracts numbers the result. `producedBy` lists every adapter that ran, in Catalogue order.
- **Which Models run.** `models` names Catalogue entries. An Enricher named without the Detector whose kind it serves runs and enriches nothing. A name not in the Catalogue is `unknown_model`; nothing is fetched.
- **Warmth.** Sessions are created after the socket is open, in Catalogue order, one after another (parallel creates cost the detector ~400 ms on a cold boot in the prototype). A session is a memoised promise; a request awaits it; a failed create drops the memo. `/health` reports `warm` per Model for this instance.
- **Runtime.** onnxruntime-node 1.29, `intraOpNumThreads` = available parallelism. The host refuses to start when the runtime's major differs from the constant the adapter versions were bumped against.
- **Timing.** `Server-Timing: decode;dur=…, <model>;dur=…` on every `/annotate`, and one stdout line per request. Never in the Annotation.

### The Catalogue

Each Model lives in one folder under the host's private `adapters/`: the adapter, its preprocessing and decode, the `.onnx` weights, `LICENCE.txt` (verbatim text plus the provenance chain, as the prototype's D-FINE file did), and `weights.sha256`.

| Name       | Role               | Kinds                                   | Weights                                        | Licence                                             | Carried over on                                                                                 |
| ---------- | ------------------ | --------------------------------------- | ---------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `yunet`    | Detector           | `face`                                  | `face_detection_yunet_2026may.onnx`, 229,738 B | MIT                                                 | boxes within 0.03 of hand marks on the fixtures; the 2026may export takes a symbolic input size |
| `edgeface` | Enricher on `face` | –                                       | `edgeface_xs_gamma_06.onnx`, 7,277,244 B       | code BSD-3, weights CC BY-NC-SA 4.0 (ADR-0003 risk) | enrolled-vs-stranger cosine band 0.43 wide, held across a resolution change (#68)               |
| `dfine`    | Detector           | `person`, `vehicle` (five road classes) | `dfine_n_coco.onnx`, 15,434,935 B              | Apache-2.0                                          | finds the kart on 29 of 32 on-track photographs where YuNet finds 9 faces (#68)                 |

- **Names** name the adapter, not the checkpoint. **Versions** are hand-bumped integer strings from `"1"`, under contracts' rule (weights, preprocessing, class list, thresholds, runtime major). A test hashes each `.onnx` against `weights.sha256`, so a weights swap without an adapter change fails CI and the version bump is a line in the same diff.
- **yunet**: input 640 px long edge, padded bottom-right to a multiple of 32, BGR 0..255; score 0.6 (opencv_zoo's demo value: a Crop wants background faces), NMS 0.3, top-k 5000 before NMS (OpenCV's order); the twelve-tensor decode ported from OpenCV's `FaceDetectorYNImpl`. Boxes and landmarks clamped to the image: contracts' `Point` is a fraction in `[0, 1]`, so an eye guessed past the border is written on the border (ADR-0007, Decision 4). A box the clamp empties is dropped. Five landmarks in YuNet's order, which is ArcFace's.
- **dfine**: input stretched to 640x640 (`do_pad: false`), RGB 0..1, no mean/std; sigmoid per class; score floor 0.28 (load-bearing: `on-track-dark-visor.jpg`'s two karts score 0.284 and 0.280), per-class NMS 0.6, top-k 50 after NMS. COCO `person` → kind `person`; `motorbike, bicycle, car, bus, truck` → kind `vehicle`; every other class is dropped, `boat`, `aeroplane` and `train` among them. `label` is COCO's word unaltered. The table lives in [`CONTEXT.md`, models](../../CONTEXT.md#models) because frame composes the kart on it. Measured by the frame agent on `fixtures/karts/objects.json` (six recorded D-FINE detections, 6 Sep 2026): eight COCO vehicle classes reproduce the recorded kart Subject on 5 of 6, the five road classes on 6 of 6; the failure is a `boat` box at 0.506 spanning 0.9239 x 0.2992 of `on-track-dark-visor.jpg` that outweighs the true `motorbike` at 0.294 by area, and no score floor separates them.
- **edgeface**: for every `face` Region, the ArcFace similarity warp (Umeyama closed form, no reflection) from the five landmarks in Decoded Image pixels to InsightFace's 112x112 template, via sharp `affine` on the Decoded Image; RGB, `[-1, 1]`; one batched inference; L2-normalised 512 floats. A face the warp refuses keeps its Region and gets no Face Print. No minimum face size here: whether a print is worth comparing is identify's Identifiable Face.
- **Licence gate.** contracts' `licence` is read from `LICENCE.txt` at construction; a missing or empty file fails construction and the conformance check. A models test asserts each text names its declared id.
- **Weights in git**, plain. Three files, 23 MB, changed rarely.

### The image

`node:24-slim`, `ORT_DISABLE_TELEMETRY=1`. The 1.29 Linux binary carries POSIX telemetry (1.29.0 release notes; a CA-bundle warning at session create, measured in `.temp/ort-proto`), and a container that holds photographs uploads nothing. onnxruntime-node ships glibc binaries for linux x64 and arm64 and no musl build (1.29.0 tarball, checked 6 Sep 2026), so the skeleton's alpine base cannot run it. esbuild bundles `server.ts` with `onnxruntime-node` and `sharp` external; `pnpm --filter @meco/models --prod deploy` gives a flat `node_modules` for the two natives; ORT is pruned to the build's `TARGETARCH` (the tarball carries ~280 MB across five platforms); `ONNXRUNTIME_NODE_INSTALL=skip` stops the CUDA postinstall. Weights and licence files are copied into the image, never fetched. File name and root stay as DEPLOY.md and #97 measured: `Dockerfile.vercel` at the repository root, `root: "."`.

Memory stays on the platform default (2 GB / 1 vCPU) until `/health`'s `rss` on the deployed container says otherwise. Prototype provenance: image 143 MB on disk with all three models; RSS never recorded.

## Testing decisions

- Tests cross the package's root files and nothing else; dependency-cruiser's `tests-through-entrypoints` enforces it, so the adapters a conformance test needs are reached through `catalogue.ts`, never through `lib/`.
- **Adapter conformance**: one Vitest file per adapter maps `adapterConformance(adapter, fixtures)` onto `it` blocks. `fixtures.image` is the host's own decode of `fixtures/faces/artemis-2-crew.jpg` (yunet, edgeface) and `fixtures/karts/on-track-dark-visor.jpg` (dfine); `blank` is a 4x4 mid-grey image built in the test. Fixtures are read by path, never imported.
- **Enricher conformance**: models' own `Check[]`, same shape as contracts', each with the mutation that turns it red: same image and Regions twice gives prints with cosine at least 0.9999 (shuffle); every `facePrint.model` equals the Enricher's `model` (stamp another version); a Region the warp refuses is returned unchanged and without a Face Print (drop it); a Region of a kind the Enricher does not serve is untouched (touch a vehicle); output has the input's length and order (reorder); every print is unit length within 1e-3 (skip normalisation); `licence` is non-empty (empty it).
- **Golden checks** against the committed `expected.json` files: every hand-marked face and kart is found with IoU at least 0.5 and centre within 0.03, the prototype's hand-marked tolerance; the dark-visor fixture yields zero faces and at least one `vehicle`; and no `vehicle` Region from the dark-visor fixture is wider than 0.9 of the frame (the `boat` box the five-class table exists to drop).
- **Boundaries**: the repo's boundaries test plants a `models/index.ts` that imports `sharp` and a gateway file that imports `models/app.ts`, and asserts both go red.
- **Weights pin**: sha256 of each `.onnx` equals `weights.sha256`.
- **HTTP**: `createApp(catalogue).request("/annotate", …)` with a fixture body parses as contracts' `Annotation`; each error code is produced by its named input; `?models=dfine` yields no `producedBy` entry for yunet.
- **Client**: `createModelsClient` against `createApp().fetch`, so the client and the app are tested as one seam without a socket; each wire error maps to its `ModelsError` code; `hash_mismatch` on a doctored response.
- **Live**: the probe script against the deployed container is part of every ticket's acceptance. Every serious prototype bug was found this way.
- **Proved able to fail**: every check names the mutation that turns it red, and the ticket runs it.

## Measurements

The four numbers [models: `POST /annotate` with the YuNet Detector (#118)](https://github.com/timschoch/meco/issues/118) owes, each with where and how it was taken. A number without provenance is a trap.

### Local container, 6 Sep 2026

`docker build --platform linux/arm64 -f Dockerfile.vercel`, `docker run --cpus=1 --memory=2g`, Docker Desktop 29.7.2 on Apple silicon, `node:24-slim` (Node 24.20.0), onnxruntime-node 1.29.0, sharp 0.35.4. Probe: `pnpm --filter @meco/models probe`. The platform's own numbers below supersede these where both exist.

| Measurement                                   | Value                                                                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boot to listening, `yunet` session create     | `yunet warm in 68ms` after `models listening on 80`                                                                                                                                      |
| `rss` after warm-up, before any inference     | 117 MB                                                                                                                                                                                   |
| `rss` after one inference (crew, 1280x1600)   | 152 MB                                                                                                                                                                                   |
| `rss` after the 5878x7348 fixture (5.4 MB)    | 216 MB                                                                                                                                                                                   |
| `Server-Timing`, crew fixture, first request  | `decode;dur=12.0, yunet;dur=43.6`; wall 93 ms                                                                                                                                            |
| `Server-Timing`, crew fixture, second request | `decode;dur=19.6, yunet;dur=41.3`; wall 71 ms                                                                                                                                            |
| `Server-Timing`, 5878x7348 fixture            | `decode;dur=248.1, yunet;dur=69.4`; wall 381 ms. Decode dominates at 43 MP even with shrink-on-load; the detector's cost barely moves because it sees a 1600 px Decoded Image either way |
| 5.4 MB body                                   | accepted, 200, straight to the container. Says nothing about the binding                                                                                                                 |
| Telemetry                                     | no telemetry line in the boot log. One `onnxruntime cpuid_info warning: Unknown CPU vendor` line, Docker's CPU emulation, harmless                                                       |

### Deployed container

Taken on the preview deployment of [the PR that closes #118](https://github.com/timschoch/meco/pull/141), Vercel `fra1`, platform default 2 GB / 1 vCPU, 6 Sep 2026. A row marked open has not been measured yet and says why.

| Measurement                                           | Value                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (1) a ~6 MB body over the service binding             | open: needs a gateway route that forwards a body to `MODELS_URL`; the gateway has none yet                                                                                                                                                                                                                                                    |
| (2) models reachable from outside without the binding | no. On both preview hostnames (`meco-1vylz5mli-…`, `meco-git-feat-models-annotate-yunet-…`) `GET /models`, `POST /annotate` and `GET /models/health` answer the gateway's `404 Not Found`; only `GET /health` answers, from the gateway. No hostname for models exists outside the binding. `MODELS_TOKEN` stays a reopen trigger, not a task |
| (3) `rss` after warm-up and after one inference       | open: `/health` on models is reachable only through the gateway, which does not forward it yet                                                                                                                                                                                                                                                |
| (4) per-stage `Server-Timing` at 1 vCPU               | open: same reason as (3)                                                                                                                                                                                                                                                                                                                      |

Seen on the way: the gateway's `/health` probe of models uses a 2 s timeout, and the first call after the preview scaled to zero answered `"reachable":false,"status":null` while the second, seconds later, answered `"reachable":true,"status":200`. A cold models instance takes longer than 2 s to answer; the gateway module owns what that report should say.

## Out of scope

- A store key on the wire (opens only if the body-limit measurement bites).
- Per-consumer models, a fourth model, GPU execution providers, quantised weights (measured 2.3x slower and less accurate in the prototype).
- Any framing policy: the kart is `frame`'s composition of a `vehicle` and the `person` on it.
- Identification, thresholds, Identifiable Face: identify's.
- Caching Annotations: records'.
- A token between the two containers.

## Further notes

`CLAUDE.md` cites "31 ms decode vs 28 ms inference". The prototype's `DEPLOY.md` records 10.5 ms decode-and-resize and 28.6 ms inference on a 1400x875 photograph, and ~100 ms of decode on 12 MP. The ordering holds at photograph sizes; the 31 ms figure has no traceable measurement and is not repeated here.
