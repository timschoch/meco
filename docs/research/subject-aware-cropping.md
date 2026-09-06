# Finding the Subject and framing it — subject-aware Crop options & recommended architecture

_Research date: 2 Sep 2026. Every claim below was read from a primary source — official docs, GitHub source/LICENSE, npm registry data, model cards, papers, official legal texts. Sources at the bottom. Claims that could not be verified from a primary source are marked **unverified**._

> **This is a point-in-time research snapshot, not the spec.** It records the options that exist and why one was picked. For what meco actually is, read [`CONTEXT.md`](../../CONTEXT.md) and [`docs/adr/`](../adr/). Domain terms below are the ones defined there — Source Image, Subject, Crop, Crop Anchor, Image Slot, Subject Area — and are used exactly as defined.

---

## TL;DR

1. **meco already reads a saliency point and throws it away.** `sharp` surfaces `info.attentionX` / `info.attentionY` on `toBuffer({resolveWithObject:true})` when `position: sharp.strategy.attention` is used, available since sharp 0.32.0; meco is on `^0.35.3`. Those two fields are **not** in Source Image coordinates — see Q2 — the Source Image point comes from `cropOffsetLeft`/`cropOffsetTop` in the same response instead. That is a one-line change to `src/crop.ts` and the cheapest possible v1 Subject.
2. **A Subject is a rectangle, not a strategy.** Restructure `cropImage` around a resolved **Subject box list** and solve the crop window analytically. Every existing input becomes a producer of that list: Crop Anchor, saliency point, detected face, recognised person, detected object. The Template's Subject Area becomes the _target_ the solver aims at. This is the single highest-leverage design decision in the whole thing, and it is the one meco's own comment in `src/crop.ts` already anticipates.
3. **One runtime: `onnxruntime-node`.** EdgeFace forces ONNX Runtime into the image, so every other component is now measured against "does it justify a second runtime". None do. YuNet runs as a raw ONNX graph, so `@techstark/opencv-js` is dropped (−14.7 MB). RTMPose replaces MoveNet, so the whole TensorFlow.js tree is dropped (−83.4 MB, and it was the least maintained thing in the plan). `sharp.affine()` does the ArcFace alignment warp, so no OpenCV is needed anywhere. The cost is roughly 210 lines of decode written once, against three fewer runtimes.
4. **Face recognition of your own people is legally the expensive part, not technically.** A facial template is _sensitive personal data_ under Swiss revFADP Art. 5 lit. c and a _special category_ under GDPR Art. 9(1). Explicit consent per enrolled person, embeddings not photos, gallery stays on your own container. **InsightFace weights are non-commercial-research-only** — read the exact quote below before anyone imports `buffalo_l`. EdgeFace is the chosen model, but **its weights are not BSD-3 and this is unresolved** — see the blocking-risk box in Q4. Do not fall back to ONNX Model Zoo ArcFace: it is a 2018 opset-8 export, unmaintained, trained on withdrawn MS-Celeb-1M.
5. **The kart case does not run on faces at all.** A closed-visor helmet leaves no facial skin. NIST measured top algorithms going from 0.3% to ~5% failure with a mere _mask_; a helmet is strictly more occlusion. Use **pose estimation as the head locator**: **RTMPose-t** (Apache-2.0, official 13.35 MB ONNX, 6.32 ms measured on CPU) puts its nose/eye/ear keypoints **on the helmet**, and does it with roughly twice MoveNet's confidence on the same photos. Identity, when you need it, comes from the kart number or helmet livery, not the face.
6. **Store annotations in meco's own storage, shaped as IPTC Image Regions.** `Iptc4xmpExt:ImageRegion` with `rbUnit=relative` is the only standard that models a **role** — and IPTC's role vocabulary literally contains `subjectArea`, `mainSubjectArea`, `cropping`, `landscapeCropping`, `portraitCropping`, `squareCropping`. That is meco's Subject Area concept, already standardised. Own-storage JSON is the system of record; embedded XMP is a projection written on export.
7. **Do not put a vision language model in the crop path.** Gemini and Claude both document coordinate output, but Anthropic's own docs say _"coordinate and localization outputs are approximate"_ and the published grounding benchmarks are weak (GPT-4o 36.8% mean IoU on one; ~57% on _pointing_, an easier task). A 5% coordinate error on a 4000 px photo is 200 px — a visibly off-centre head. Use a vision model to **label training images offline**, not to frame a Crop.

### Recommended architecture, phased

|         | Scope                         | What ships                                                                                                                                                               | Added weight                           |
| ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| **v1**  | Saliency Subject + the solver | Refactor `cropImage` to a Subject-box solver with phi-grid placement; read sharp's saliency point (Q2) as the fallback Subject                                           | **0**, no new dependency               |
| **v2**  | Faces                         | YuNet ONNX via `onnxruntime-node`; faces become high-priority Subject boxes with a headroom rule                                                                         | +45 MB runtime (pruned) + 230 KB model |
| **v3**  | Known people                  | EdgeFace embeddings (`edgeface_xs_gamma_06`, exported to ONNX once offline) + a local gallery; `sharp.affine()` does the alignment warp; recognised face wins the anchor | ~7 MB model, runtime already present   |
| **v3′** | Kart + driver's head          | Fine-tuned D-FINE-N (Apache-2.0) finds the kart; RTMPose-t finds the head inside it                                                                                      | +15 MB detector, +13 MB pose           |
| any     | Annotation                    | Sidecar JSON shaped as IPTC Image Region; human override as a second region                                                                                              | 0                                      |

v1 is worth shipping on its own. v2 is where the quality jump is. v3 and v3′ are independent of each other — do whichever brand needs it first.

---

## Q1 — Where meco stands today

`src/crop.ts` currently exposes two ways to frame a Crop:

- a **Crop Anchor** (nine regions) mapped to a libvips gravity string, and
- a `strategy` of `"attention" | "entropy"` handed to `sharp.strategy.*`.

`SubjectArea` is declared as an interface and **used nowhere** — a seam with nothing plugged into it. The file's own header comment states the intent: _"Tomorrow a smarter Crop will read the Subject Area off a Template and choose the anchor that satisfies it."_ This document is about what to plug in.

Runtime constraints that eliminate options before quality does:

- **`node:24-slim`** — `Dockerfile.vercel`. Note this tag is **Debian bookworm**, not trixie: `node:24-slim` and `node:24-bookworm-slim` resolve to the same Docker Hub digest, and `versions.json` in `nodejs/docker-node` sets Node 24's `debian-default` to `bookworm`. That means **glibc 2.36 and libstdc++ from GCC 12** (GLIBCXX_3.4.30 / CXXABI_1.3.13). Trixie needs the explicit `node:24-trixie-slim` tag. Either clears every native dependency below, but the doc should say which one it means. Minimal packages, no build toolchain, no `libGL`.
- **Vercel Functions container, scale-to-zero** — cold start is a per-request cost, so image size and model load time are real.
- **CPU only.** No GPU anywhere in the pipeline.
- **`sharp ^0.35.3` already present** — free decode to raw RGB buffers, which every JS detector needs anyway.
- **Compiled JS, not `tsx`** — models must be baked into the image at build time, never fetched at boot.

---

## Q2 — Method family 1: saliency and attention-based cropping

Nothing here knows what a face is. These methods answer "where is the visual energy" and are the correct **fallback**, not the primary Subject.

| Method                             | Gives coordinates?                                                                        | Boost a known region?         | Cold start            | Licence                | Cost                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------- | --------------------- | ---------------------- | -------------------------- |
| **sharp `strategy.attention`**     | ✅ point, via `cropOffsetLeft/Top` (`attentionX/Y` is _not_ in source coords — see below) | ❌                            | none                  | Apache-2.0 / LGPL-2.1+ | free                       |
| **sharp `strategy.entropy`**       | rect only, no point                                                                       | ❌                            | none                  | same                   | free                       |
| **smartcrop.js + smartcrop-sharp** | ✅ `topCrop` rect, never crops                                                            | ✅ **`boost`, weight 100**    | none                  | MIT                    | free                       |
| OpenCV Spectral Residual (ported)  | ✅ dense map                                                                              | ✅ you write the scorer       | none                  | Apache-2.0 algorithm   | free                       |
| u2netp ONNX                        | ✅ dense map                                                                              | ✅                            | bad (+296 MB runtime) | Apache-2.0 / MIT       | free                       |
| Google Vision `cropHints`          | ✅ `boundingPoly`, source coords                                                          | combine with `FACE_DETECTION` | none                  | SaaS                   | $1.50/1k units, 1k free/mo |
| Cloudinary `fl_getinfo`            | ✅ `g_auto` rect as JSON                                                                  | ✅ `g_auto:face`              | none                  | SaaS                   | credits                    |
| imgix                              | ❌ no JSON coords                                                                         | `crop=faces` only             | none                  | SaaS                   | $25/mo+                    |
| Thumbor `/meta/`                   | ✅ `focal_points`                                                                         | ✅ Haar detectors             | heavy Python sidecar  | MIT                    | self-host                  |

### sharp `attention` — what it actually computes

sharp does not implement it. `src/pipeline.cc` calls libvips `vips_smartcrop()` and passes out-parameters `attention_x` / `attention_y`. libvips `libvips/conversion/smartcrop.c` states in its own header that it is _"Adapted from sharp's smartcrop feature"_ and that the constants come _"From smartcrop.js"_. The algorithm, read from source:

1. Downsample to **32×32**. _"The size we shrink to gives the precision with which we can place the crop."_
2. Convert to XYZ, keep 3 bands.
3. **Edge channel** — Laplacian on Y, kernel `[0,-1,0; -1,4,-1; 0,-1,0]`, ×5, absolute value.
4. **Skin channel** — normalise each pixel by XYZ magnitude, Euclidean distance from the fixed vector `{-0.78, -0.57, -0.44}`, rescaled `100 → 0`, then zeroed wherever `Y < 5.0`.
5. **"Saturation" channel** — the LAB `a` band (green↔red), same dark mask. Not chroma.
6. Sum the three, Gaussian blur, then **`vips_max()`** — a single-pass argmax. Not an iterative ranking, whatever sharp's docs say.
7. `attention_x = x_pos / hscale`, then centre a fixed-size window on it and clamp.

**Three gotchas that will bite:**

- **`cropOffsetLeft` / `cropOffsetTop` are negated.** libvips `extract.c` sets `out->Xoffset = -extract->left`. sharp's own test asserts `-107`. Use `-info.cropOffsetLeft`.
- **`attentionX`/`attentionY` are not in Source Image coordinates — the field name implies more than sharp promises.** Measured against sharp 0.35: the value is the resized-probe coordinate multiplied by whatever shrink-on-load the JPEG decoder chose (`baton->attentionX = attention_x * jpegShrinkOnLoad / scale`), and that factor is never exposed, so it varies with the source's file format alone. On a 1600×1000 photo with its Subject at 0.68 of the width, a 32 px probe reports `attentionX` **33 as a PNG** and **264 as the same picture re-encoded as JPEG** — an 8× gap from nothing but the container. `cropOffsetLeft`/`cropOffsetTop` do not have this problem: they are post-resize offsets in the probe's own already-known scale, so undoing only that resize (never a hidden decoder factor) lands back on the same Source Image fraction regardless of format. **Use `cropOffsetLeft`/`cropOffsetTop`, not `attentionX`/`attentionY`.**
- **The crop block is skipped entirely when no crop is needed.** An exactly-aspect-matching request returns neither pair of fields. Guard for `undefined`.

Reading the point without paying for a full-size crop: request a tiny aspect-matched resize with `.raw()`, for a buffer of about 3 KB. `saliencyPoint` in `src/crop.ts` is the worked implementation — it reads `cropOffsetLeft`/`cropOffsetTop` off exactly this call, for the reason above, and undoes only the resize scale to recover a Source Image fraction.

**Accuracy caveats, all from source:** the argmax runs on a 32×32 grid, so positional precision is ~3% of image width. The skin detector is one fixed XYZ vector with a hard dark cutoff — a known bias against dark skin tones and a failure mode in low-key images. No face detection. **No way to bias a known region.**

### smartcrop.js — the only local method with a boost hook

> **Dropped from the plan on maintenance grounds — see the maintenance check below.** `smartcrop@2.0.5` was published **2021-09-01** and `smartcrop-sharp@2.0.8` on **2023-09-04**; the two repos were last pushed **2024-03-16** and **2023-09-04**. Both are well past an 18-month cutoff, and `smartcrop-sharp` still declares `peerDependencies: sharp ^0.32.5`, which strict peer resolution rejects against sharp 0.35. The algorithm below is still the best-documented saliency scorer in this survey and is worth reading; take the ideas, not the dependency.

MIT, 30.6 KB, zero runtime dependencies.

It packs four signals into the RGBA channels of one working image — **R = skin, G = edge/detail, B = saturation, A = boost** — then slides a window over candidate crops and scores each. The scoring function includes the composition term libvips omits entirely:

```js
if (options.ruleOfThirds)
  s += max(0, s + d + 0.5) * 1.2 * (thirds(px) + thirds(py));
```

**`boost` is the mechanism that makes a known face win.** From the README: _"optional array of regions whose 'interestingness' you want to boost (for example faces)"_, each `{x, y, width, height, weight}`. `boostWeight` defaults to **100.0** against a `detailWeight` of **0.2** — a boosted region dominates by 500×. This is the one capability neither libvips nor imgproxy offers, and it lives in a 30 KB dependency with no native code.

`smartcrop.crop(image, options)` returns `{ topCrop: {x, y, width, height} }` in original pixels and **never crops** — exactly the read-a-rectangle-without-cropping property meco wants. `prescale` downsamples to 256 px before analysis, so cost is roughly input-size-independent after decode. README benchmark: _"< 20 ms to find a square crop of a 640x427px picture on an i7."_

**What to do instead.** v1 ships with `sharp`'s saliency point alone (Q2) — a point, not a rectangle, which the solver in Q6 handles natively because it only ever needs an anchor plus an optional extent. From v2 on, a detected face is a far better Subject than any saliency heuristic, so the boost mechanism has nothing left to do: boosting exists to force a known region to win a _search_, and the solver does not search. If a dense saliency rectangle is ever genuinely wanted, vendor the ~300-line scoring loop rather than take a four-year-old dependency — it is MIT, self-contained, and has no transitive deps.

### Everything else in this family

- **imgproxy's `gravity:sm` is a bare `vips_smartcrop(in, out, w, h, NULL)`** — it does not even read the attention point. meco is not behind the baseline; it is at it.
- **Google Vision `cropHints`** returns `boundingPoly` _"in the original image's scale"_, plus `confidence` and `importanceFraction`. `aspectRatios` accepts an array, capped: _"The number of provided aspect ratios is limited to a maximum of 16."_ `CROP_HINTS` + `FACE_DETECTION` fit in one `AnnotateImageRequest`, billed as 2 units. $1.50 per 1,000 units, first 1,000 units/month free. Best accuracy-per-effort if a network hop per Crop is acceptable — but it makes a Crop depend on GCP availability and a secret.
- **Cloudinary `fl_getinfo`** is the only product surveyed that returns a saliency-derived crop rectangle as JSON. Interesting as a reference implementation of the idea; wrong shape as a dependency (it is a whole DAM + CDN).
- **imgix `fp-x` / `fp-y` / `fp-z`** — `fp-x`/`fp-y` are floats 0.0–1.0 defaulting to 0.5, `fp-z` is 1–100 where _"every full step is the equivalent of a 100% zoom"_. **The composition math is not documented anywhere** — only a qualitative description plus an `fp-debug` overlay. You cannot copy it from a primary source.
- **Thumbor's `get_center_of_mass`** is the well-sourced substitute: a weight-summed centroid over focal points, then centre-and-clamp. That is the math worth copying, and it is in `thumbor/transformer.py`. Thumbor also has a `/meta/` endpoint that _"simulates the operations"_ and returns `focal_points` as JSON instead of an image — good architecture, wrong runtime (a Python + OpenCV container on a scale-to-zero platform).
- **OpenCV Spectral Residual** is fully specified in `staticSaliencySpectralResidual.cpp` (64×64, DFT, log-amplitude minus a 3×3 box blur, inverse DFT, `GaussianBlur(5×5, σ=8)`, square, normalise) — but `saliency` is **not in the official OpenCV.js whitelist**, so it is unreachable from JS without compiling OpenCV+contrib yourself. Port the eight steps instead if a dense map is ever wanted; the constants are all pinned in that file.
- **u2netp ONNX** (4.36 MB, Apache-2.0, 320×320) is the only credible ONNX saliency option. The full u2net is 168 MB and a non-starter. **No CPU latency figure is published for any of U²-Net / BASNet / TRACER** — benchmark, do not cite.

---

## Q3 — Method family 2: face detection on CPU in Node

| Option                                    | Image Δ              | Model            | Weights licence        | Works on `node:24-slim`?                 |
| ----------------------------------------- | -------------------- | ---------------- | ---------------------- | ---------------------------------------- |
| **YuNet via `onnxruntime-node`** ← chosen | 45.1 MB pruned       | 229,738 B        | **MIT**                | ✅ no apt packages, you write the decode |
| YuNet via `@techstark/opencv-js`          | 14.7 MB              | 232,589 B        | **MIT**                | ✅ but it is a second runtime            |
| `@vladmandic/human` + tfjs-wasm           | 43.7 MB + 13.2 MB    | blazeface 618 KB | Apache-2.0 (BlazeFace) | ✅                                       |
| `@vladmandic/human` + tfjs-node           | 43.7 MB + **401 MB** | same             | same                   | ❌ **broken on Node ≥23**                |
| `face-api.js`                             | 4.87 MB + backend    | 5.6 MB / 193 KB  | MIT                    | dormant since 2024-01                    |
| `@vladmandic/face-api`                    | 23.65 MB             | same             | MIT                    | ❌ **archived 2025-02-05**               |
| `@mediapipe/tasks-vision`                 | 35.1 MB              | 230 KB / 1.1 MB  | Apache-2.0             | ❌ **hangs in Node**                     |
| SCRFD / RetinaFace (InsightFace)          | 45.1 MB              | 2.5–16.9 MB      | ❌ **non-commercial**  | licence-blocked                          |
| YOLOv8/v11-face                           | 45.1 MB              | 11.7 MB+         | ❌ **AGPL-3.0**        | licence-blocked                          |
| AWS Rekognition `DetectFaces`             | 0                    | n/a              | n/a                    | ✅ network hop                           |

### The two hard blockers

**`@tensorflow/tfjs-node@4.22.0` crashes on Node 23+.** It calls `util.isNullOrUndefined`, removed from Node in nodejs/node#52744. The fix (tensorflow/tfjs#8425) merged 2025-04-23 and **is still unpublished** — even the `4.23.0-rc.0` tarball still contains the call sites. meco's base image is `node:24-slim`, so this is fatal, not inconvenient. Separately, its install step downloads a 112 MB tarball that unpacks to ~401 MB of `libtensorflow`, and its prebuilt list has **no linux/arm64**. Anything that recommends `tfjs-node` for meco is wrong.

**`@mediapipe/tasks-vision` does not run in Node.** `FaceDetector.createFromModelPath()` throws `ReferenceError: document is not defined`; polyfilling with jsdom gets past that and then `createFromOptions()` **hangs forever** with `delegate: "CPU"`. Google's own maintainer, on an open issue: _"We currently only support browser environments and don't have testing infrastructure that can validate that our libraries work in Node."_ The docs list Android, Python, Web and iOS — Node is absent.

### YuNet — the recommendation

**Use `face_detection_yunet_2026may.onnx`, 229,738 bytes, not the 2023mar file.** Both are **MIT © 2020 Shiqi Yu** — the `opencv_zoo` README states _"All files in this directory are licensed under MIT License."_ They are the same weights: the README says the newer file was _"re-exported from `face_detection_yunet_2023mar.onnx` with static H/W dims replaced by symbolic dims"_, and feeding both the same 640×640 input gives outputs agreeing to 4.0e-6. The difference is decisive for a raw ONNX Runtime route: **`2023mar` is hard-locked to 640×640 and ORT rejects any other shape** (`INVALID_ARGUMENT: Got invalid dimensions for input`), because ORT's `free_dimension_overrides` can only rewrite symbolic dims, not static ones. OpenCV's DNN module reshapes by shape propagation and hides this; ORT does not.

It returns a `[num_faces, 15]` row: bbox `x,y,w,h`, then 5 landmarks (right eye, left eye, nose tip, right mouth corner, left mouth corner), then score. The landmarks matter twice over — the eye midpoint drives the headroom rule, and the same five points are exactly what the ArcFace alignment in v3 consumes, in exactly this order.

WIDER FACE, from `opencv_zoo`'s own eval tooling against the exact `.onnx` you would ship: **Easy 0.8844 / Medium 0.8656 / Hard 0.7503**. (Two other primary sources give different numbers under different eval protocols — the paper says 0.834/0.824/0.708, `libfacedetection` says 0.887/0.871/0.768. Use the first.) Project CPU benchmark, native C++ at 160×120: **0.69 ms** on an i7-12700K, 6.23 ms on a Raspberry Pi 4B.

`@techstark/opencv-js` remains a valid route and is less work — `FaceDetectorYN` is in the official OpenCV.js whitelist (`platforms/js/opencv_js.config.py`, under `objdetect`, added 2024-04-17) and the package is the official `opencv.js` repackaged, so WASM does the decode and NMS for you. **It is dropped only because EdgeFace already forces ONNX Runtime into the image, and 14.7 MB of emscripten for one model that ORT can run directly is not worth a second runtime.** If v3 is ever dropped, revisit this.

### Preprocessing YuNet yourself

Read from `FaceDetectorYNImpl` in `modules/objdetect/src/face_detect.cpp`. It calls `dnn::blobFromImage(pad_image)` with **no optional arguments**, whose defaults are `scalefactor=1.0`, `mean=Scalar()`, `swapRB=false`, `crop=false`, `ddepth=CV_32F`. So:

- **BGR, not RGB.** `swapRB=false` keeps the `Mat`'s native order, which in OpenCV is BGR. sharp gives you RGB — swap the two planes when packing the tensor.
- **Raw 0–255.** No `/255`, no mean subtraction, no normalisation.
- **NCHW `[1, 3, padH, padW]`, float32.**
- **Pad bottom and right only, to a multiple of 32**: `padW = ((inputW - 1) / 32 + 1) * 32`, via `copyMakeBorder(img, out, 0, bottom, 0, right, BORDER_CONSTANT, 0)`. Because the padding is bottom/right, **detections need no un-padding offset** — they are already in the un-padded frame. `sharp`'s `.extend({ right, bottom, background: '#000' })` does exactly this.
- There is **no letterboxing and no aspect-preserving resize inside the detector.** Resize to a working resolution yourself, aspect-preserving, then pad; scale detections back by the resize factor alone.

The dynamic model does not remove the pad-to-32 requirement — 300×300 fails inside the network with a broadcast mismatch, while 32×32, 640×480 and 672×384 all succeed with `anchors == (H/8)·(W/8)`.

### The decode, precisely

**12 output tensors** fetched by name in this order: `cls_8/16/32`, `obj_8/16/32`, `bbox_8/16/32`, `kps_8/16/32`. Shapes are `[1, N_s, 1]`, `[1, N_s, 1]`, `[1, N_s, 4]`, `[1, N_s, 10]` where `N_s = (padH/s)·(padW/s)`. **`cls` and `obj` are already sigmoid'd** — the graph tail is a `Sigmoid` node. `bbox` and `kps` are raw.

The detector is **anchor-free**: one prior per grid cell, no anchor boxes, no scales. Layout is row-major (`Conv → Transpose(0,2,3,1) → Reshape(1,-1,C)`), so `idx = r * cols + c` with `cols = padW/stride`.

```
for stride s in [8, 16, 32]:
  for r in rows, c in cols:
    idx   = r * cols + c
    score = sqrt(clamp01(cls[idx]) * clamp01(obj[idx]))     // geometric mean
    if score < scoreThreshold: continue
    cx = (c + bbox[idx*4+0]) * s ;  cy = (r + bbox[idx*4+1]) * s
    w  = exp(bbox[idx*4+2]) * s  ;  h  = exp(bbox[idx*4+3]) * s
    box = { x: cx - w/2, y: cy - h/2, w, h }                // top-left + size
    for n in 0..4:
      kp[n] = { x: (kps[idx*10+2n]   + c) * s,
                y: (kps[idx*10+2n+1] + r) * s }             // offset by CELL, not centre
```

Then greedy NMS: sort descending by score, truncate the candidate list to `topK` **before** NMS, keep a box when its IoU against every kept box is `<= nmsThreshold`. Defaults from `face.hpp` are `score_threshold=0.9`, `nms_threshold=0.3`, `top_k=5000`; opencv_zoo's own demo wrapper uses `0.6 / 0.3 / 5000`. OpenCV truncates boxes to integer rects before NMS — a float port differs sub-pixel, which matters only if you want bit-exact parity in a test.

**No existing JS/TS YuNet decoder was found.** Budget ~150 lines and a fixture image with known-good output.

### `onnxruntime-node` operational notes

- **296 MB unpacked**, because `bin/napi-v6/` ships all five platforms: `darwin/arm64` 84 MB, `win32/arm64` 69 MB, `win32/x64` 63 MB, `linux/x64` **43 MB**, `linux/arm64` 24 MB. Prune the four you do not need in the Dockerfile and the dependency drops ~6×. Note `darwin/x64` is **not** shipped — an Intel Mac has no prebuilt binary.
- **The postinstall downloads CUDA 12 provider binaries on `linux/x64` and only there.** `install-metadata.js` sets `requirements: { 'linux/x64': ['cuda12'], ... }` and pulls `Microsoft.ML.OnnxRuntime.Gpu.Linux` from `api.nuget.org`. Set **`ENV ONNXRUNTIME_NODE_INSTALL=skip`** before `npm ci` — the env var is checked first, ahead of the `--onnxruntime-node-install=skip` CLI flag.
- **No extra apt packages.** `libonnxruntime.so.1` needs at most `GLIBC_2.28` and `CXXABI_1.3.11` (the tighter of the two libstdc++ constraints — CXXABI_1.3.11 is GCC 7.1, GLIBCXX_3.4.22 only GCC 6.1). `NEEDED` is `libdl, librt, libpthread, libstdc++, libm, libgcc_s, libc, ld-linux` and nothing else. No `libgomp`, no `libGL`, no `libnuma`. Bookworm's glibc 2.36 / GCC 12 clears both with room.
- **Node 24 is safe by ABI contract, not by vendor statement.** The package declares no `engines` field; its README says only _"ONNXRuntime works on Node.js v16.x+ (recommend v20.x+)"_, and release notes 1.22–1.29 say nothing about Node versions. But the binaries target **N-API v6**, and Node's own docs guarantee Node-API is _"ABI stable across versions of Node.js"_, letting _"modules compiled for one major version run on later major versions without recompilation"_. Low risk, but run one `require('onnxruntime-node')` smoke test in the real image.
- Release cadence is roughly monthly: 1.27.0 on 2026-06-19, 1.28.0 on 2026-07-25, **1.29.0 on 2026-08-12**, with patches backported onto the previous minor (1.28.2 shipped 2026-09-03). npm `time.modified` 2026-09-02.

### Licence-blocked, for the record

- **InsightFace SCRFD** is the accuracy leader here (WIDER Hard **0.828** vs YuNet's 0.750) and is unusable. Root README: _"The training data containing the annotation (and the models trained with these data) are available for non-commercial research purposes only."_ `model_zoo/README.md`: _"ALL models are available for non-commercial research purposes only."_
- **Ultralytics YOLO-face** — the LICENSE is AGPL-3.0 and `ultralytics.com/license` states _"All Ultralytics YOLO trained models fall under the AGPL-3.0 License by default"_, with the Enterprise trigger list naming _"Deploy through a SaaS platform, API, or other private system."_ A fork attaching an MIT file does not launder this.

### Cloud detection, as a comparison

|           | AWS `DetectFaces`                       | Google Vision `FACE_DETECTION`                 | Azure AI Face `Detect`                      |
| --------- | --------------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| Price     | $0.0010/img first 1M/mo                 | $1.50/1,000                                    | tiered, **$ unverified**                    |
| Free tier | 1,000/mo, 12 months                     | **1,000 units/mo, permanent**                  | F0: 30,000 tx/mo                            |
| Box units | **ratios**                              | **pixels** (`boundingPoly` + `fdBoundingPoly`) | integer pixels                              |
| Landmarks | 5 default, 30 with `Attributes:["ALL"]` | ~34, 3D                                        | 27, opt-in                                  |
| Gating    | none                                    | none                                           | **detection ungated**, identification gated |

Azure's Limited Access page confirms _"The Face Detection operation is available without registration."_

---

## Q4 — Method family 3: recognising predefined people

This is the "add our faces and it pins the subject on our face" requirement. It is a 1:N open-set identification against a gallery of well under 50 identities.

| Option                         | Dim    | Metric             | Threshold guidance                            | LFW                | IJB-C @1e-4   | Weights licence                                              |
| ------------------------------ | ------ | ------------------ | --------------------------------------------- | ------------------ | ------------- | ------------------------------------------------------------ |
| `@vladmandic/human` faceres    | 1024   | Minkowski→0..1     | _"above 50% … a match"_ (wiki); demo uses 0.4 | **unpublished**    | —             | upstream Apache-2.0, dataset terms unverified                |
| face-api `faceRecognitionNet`  | 128    | Euclidean          | **0.6** (dlib + `FaceMatcher` default)        | 99.38              | not published | MIT                                                          |
| InsightFace `w600k_r50`        | 512    | cosine             | **none published**                            | 99.80              | **97.12**     | ❌ **non-commercial**                                        |
| InsightFace `w600k_mbf`        | 512    | cosine             | none published                                | 99.70              | 95.02         | ❌ **non-commercial**                                        |
| ONNX Model Zoo ArcFace R100    | 512    | cosine             | not stated                                    | 99.77 (int8 99.80) | not published | Apache-2.0 — **2018, opset 8, unmaintained, MS-Celeb-1M**    |
| **EdgeFace** (Idiap, CH, 2024) | 512    | cosine             | none published                                | 99.57–99.83        | 94.85 (xs)    | ⚠ code **BSD-3**, weights **CC BY-NC-SA 4.0** — see risk box |
| AWS Rekognition Collections    | opaque | `Similarity` 0–100 | default **80**; _"say 99%"_ to authenticate   | not published      | —             | n/a                                                          |

### The licence fork in the road

InsightFace is the obvious technical answer and the wrong legal one. The README's `## License` section, verbatim:

> **"The code of InsightFace is released under the MIT License. There is no limitation for both academic and commercial usage."**
>
> **"The training data containing the annotation (and the models trained with these data) are available for non-commercial research purposes only."**
>
> **"Both manual-downloading models from our github repo and auto-downloading models with our python-library follow the above license policy(which is for non-commercial research purposes only)."**

A 2025-11-24 update adds a licensing contact (`recognition-oss-pack@insightface.ai`). Third-party Hugging Face re-uploads tagged `license:mit` exist — a re-uploader cannot grant rights they do not hold. **Do not import buffalo_l.**

The permissive choice — **decided 3 Sep 2026: EdgeFace for the MVP.**

> ### ⚠ Blocking risk: the EdgeFace weights are not BSD-3
>
> This surfaced after the decision was recorded and it has to be resolved before v3 ships. There are two licences, and the one that matters is the restrictive one.
>
> - **Code:** `github.com/otroshi/edgeface` `LICENSE` is verbatim, unmodified **BSD 3-Clause**, © 2024 Anjith George, Christophe Ecabert, Hatef Otroshi Shahreza, Ketan Kotwal, Sébastien Marcel, Idiap Research Institute. Confirmed by reading the raw file 3 Sep 2026. GitHub's own API nonetheless reports `"spdx_id": "NOASSERTION"` for the repo, so GitHub does not classify it as a recognised licence.
> - **Weights:** the official Idiap model cards on Hugging Face — **`idiap/EdgeFace-XS-GAMMA`** and **`idiap/EdgeFace-S-GAMMA`** — both declare **`license: cc-by-nc-sa-4.0`** and link the Creative Commons deed. CC BY-NC-SA 4.0 permits use _"for NonCommercial purposes only"_.
>
> **This is structurally the same split as InsightFace**, which the section above rejects for exactly this reason: permissive code, non-commercial weights. Rejecting InsightFace on that ground and accepting EdgeFace on the strength of its code licence is not a consistent position.
>
> **Resolution path, in order.** (1) Email Idiap — the five authors are named in the LICENSE header and Idiap is a Swiss research institute in the same jurisdiction as the operator, so a commercial-use clarification or licence is a realistic ask, and it is cheap. (2) If that fails, the fallback is **ONNX Model Zoo ArcFace R100** (Apache-2.0, 63 MB int8, LFW 99.80) despite the 2018 export and MS-Celeb-1M provenance — rejected below on quality-of-maintenance grounds, not licence grounds, so it survives as a licence-clean option. (3) Failing both, drop v3 and keep face _detection_ only: v2 already gives good Crops, and recognition is the only phase this blocks.
>
> Until (1) returns, treat v3 as **conditionally planned**, and do not enrol anyone's face.

- **EdgeFace** from Idiap in Martigny, IEEE TBIOM 2024 — repo `otroshi/edgeface`. Four variants: `edgeface_base` 18.23M params LFW 99.83, `edgeface_s_gamma_05` 3.65M / 99.78, **`edgeface_xs_gamma_06` 1.77M / 99.73 / IJB-C 94.85**, `edgeface_xxs` 1.24M / 99.57. Checkpoints ship as PyTorch `.pt` in `checkpoints/` (quantised `_q` variants too); **no ONNX export is provided** — run `torch.onnx.export` once offline and bake the `.onnx` into the image. Training dataset is not named in the repo README; the paper names it. Start with `xs_gamma_06`; move to `s_gamma_05` only if the IJB-C gap shows up on real group photos.
- **ONNX Model Zoo ArcFace LResNet100E-IR** — rejected on maintenance, not licence. Apache-2.0 is genuinely declared, but the export dates from **2018** (opset 8 fp32, opset 11 int8), the folder has had no maintenance since, and it was trained on Refined MS-Celeb-1M, a dataset Microsoft withdrew whose original terms were research-only. Keep as the licence-clean fallback and as a benchmark baseline.

### Alignment: `sharp.affine()` replaces OpenCV entirely

EdgeFace, like every ArcFace-family model, wants a 112×112 crop produced by a **similarity transform** mapping the 5 detected landmarks onto a fixed canonical template. In Python that is `skimage` + `cv2.warpAffine`. The question that decides whether OpenCV stays in the image is whether `sharp` can express the same warp. **It can** — verified end-to-end on sharp 0.35.4 / libvips 8.18.6, reproducing the canonical points to within **0.17 px in 3.8 ms**.

`affine()` takes a **2×2 matrix only**, but translation is expressible through the `odx`/`ody` options. Docs and libvips agree on the transform:

```
X = matrix[0,0]*(x + idx) + matrix[0,1]*(y + idy) + odx
Y = matrix[1,0]*(x + idx) + matrix[1,1]*(y + idy) + ody
```

So `odx`/`ody` _are_ the translation column. Three things that are not obvious and will cost a day each if missed:

1. **`extract()` runs BEFORE `affine()`, always.** sharp's fixed libvips order is `extract(pre) → rotate → resize → extract(post) → affine → extend`, so `.affine(...).extract(...)` silently crops the _source_, not the warped result. Use the pre-affine `extract()` as a bounding optimisation and slice the 112×112 out of the raw buffer yourself — free, since ONNX Runtime needs a `Float32Array` anyway.
2. **The output canvas is sized from the linear part only.** libvips calls `vips__transform_set_area()` _before_ assigning `odx`/`ody`, so translation slides content inside a fixed canvas rather than growing it. Predict `oarea` as the rounded bbox of the input rect under `[[a,b],[c,d]]`, then set `odx = M[0][2] + oarea.left`, `ody = M[1][2] + oarea.top`.
3. **The documented default interpolator is wrong.** Docs and `index.d.ts` say `bicubic`; `lib/constructor.mjs` actually sets `bilinear`. That is lucky — `cv2.warpAffine` uses `INTER_LINEAR`, so leaving the default gives InsightFace parity. Do not "fix" it to bicubic.

The canonical template is InsightFace's `arcface_dst` from `python-package/insightface/utils/face_align.py`:

```python
arcface_dst = np.array(
    [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
     [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)
```

**EdgeFace expects exactly these points**, reached by a different route: its bundled `mtcnn_pytorch` uses `REFERENCE_FACIAL_POINTS` for a 96×112 crop and, with `default_square=True`, adds 8.0 to every x — which lands on `arcface_dst` to the digit. The same array is also hardcoded in OpenCV's `face_recognize.cpp`. Three independent primary sources, one template. **And YuNet's landmark order feeds it straight through with no reordering** — OpenCV's own `alignCrop` reads columns 4..13 in order and hands them to the transform.

EdgeFace preprocessing after the warp: **RGB**, `ToTensor()` to `[0,1]` CHW, then `(x-0.5)/0.5` → **`[-1, 1]`**. Corroborated by the `preprocessor_config.json` on the Hugging Face card (`rescale_factor: 1/255`, `image_mean` and `image_std` all `0.5`, `image_size: 112`).

**Computing the transform needs no library.** For a 2-D similarity without reflection there is a closed form in ~15 lines, verified equal to OpenCV's SVD-based Umeyama to `5.7e-14` over 2000 random point sets:

```
x̄,ȳ = mean(src);  ū,v̄ = mean(dst)
xᵢ,yᵢ = srcᵢ − (x̄,ȳ);  uᵢ,vᵢ = dstᵢ − (ū,v̄)
den = Σ(xᵢ² + yᵢ²)
a   = Σ(xᵢuᵢ + yᵢvᵢ) / den
b   = Σ(xᵢvᵢ − yᵢuᵢ) / den
M   = [[ a, −b,  ū − (a·x̄ − b·ȳ) ],
       [ b,  a,  v̄ − (b·x̄ + a·ȳ) ]]
```

No npm package does this: `umeyama`, `similarity-transform` and `affine-fit` do not exist on the registry; `ml-matrix` is 200 KB for an SVD you do not need; `transformation-matrix` applies matrices but cannot fit them. Write the 20 lines.

### What accuracy actually means here

LFW is saturated above 99.4% and separates nothing. **IJB-C at FAR ≤ 1e-4 is the number that predicts real group photos**: ArcFace R50 scores 97.12 where the mobile model scores 95.02 — the small model roughly triples the miss rate at fixed false-accept. face-api's 128-D descriptor has no IJB-C number at all; its 99.38% LFW is a 2017 dlib figure and its real-world gap is much larger than the LFW delta suggests.

Three properties matter for a tiny gallery:

1. **1:N multiplies the false-match rate by N.** A per-comparison FMR of 1e-4 against 50 identities is ~5e-3 that _some_ entry falsely fires on a stranger. A group photo with 20 unknown faces gives roughly a 10% chance of at least one wrong label per photo at that operating point.
2. **Run it open-set.** Take the argmax cosine similarity, require it to clear an absolute threshold **and** beat the runner-up by a margin. Never return "closest match" unconditionally. A false positive is an identity claim about a real third party; a false negative is a slightly off-centre Crop.
3. **Multiple reference photos per person is the cheapest accuracy win** — and it is what AWS explicitly endorses with user vectors aggregating up to 100 face vectors.

No source gives a recommended cosine threshold for ArcFace. **InsightFace publishes none anywhere in its repo.** Calibrate on your own enrolled set: hold out photos per person, sweep, pick the point where no non-enrolled face in a set of real group photos crosses, then add margin.

### Failure modes that matter for these brands

- **Children's faces change.** NIST FRVT Part 3 reports higher false-non-match rates for younger subjects even with no time lapse; longitudinal child studies report TAR as low as ~48% @ FAR 0.1% for ages 0–4 across sessions. **Re-enrol children roughly every six months** and timestamp each reference photo so stale ones can be retired.
- **Occlusion is brutal.** NIST on masks: _"Using unmasked images, the most accurate algorithms fail to authenticate a person about 0.3% of the time. Masked images raised even these top algorithms' failure rate to about 5%, while many otherwise competent algorithms failed between 20% to 50% of the time."_
- **A kart driver in a full-face helmet: face recognition cannot work.** No skin, no eye region, no jawline. Detection will not fire; if a box is produced anyway, the landmarks are meaningless and the embedding is noise that matches arbitrarily. NIST's mask data is the _optimistic_ bound. Do not lower the threshold to compensate — that trades a graceful miss for a confident wrong Crop. Identify the driver by kart number (OCR on the nose cone), helmet livery (a per-driver uniform in a small team, and a colour histogram beats any face model on it), suit colour, or the session schedule crossed with the EXIF timestamp.

### Cloud alternatives

- **AWS Rekognition Collections** stores face vectors, not images: _"Collections store face vectors, which are mathematical representations of faces. Collections do not store images of faces."_ $0.0010/image for the first 1M/month; face metadata storage $0.00001 per face per month (a 250-vector gallery costs a quarter of a cent a month). **`eu-central-1` Frankfurt is supported; `eu-central-2` Zurich is not** — Swiss-soil residency is unavailable on Rekognition. AWS publishes no accuracy benchmark.
- **Azure AI Face is closed to you.** Identification and verification are Limited Access: _"Face API is available only to customers managed by Microsoft, defined as those customers and partners who are working directly with Microsoft account teams."_ Detection stays open. Rule it out.
- **Google Cloud Vision does not do identity**, verbatim: _"Specific individual Facial Recognition is not supported."_

### Legal — Swiss operator, brief and factual

_This is a summary of the texts, not legal advice._

A facial template used to identify someone is **sensitive personal data** under Swiss revFADP Art. 5 lit. c (_"biometric data that uniquely identifies a natural person"_) and a **special category** under GDPR Art. 4(14) + Art. 9(1), where such processing _"shall be prohibited"_ absent a lifting condition. The applicable condition here is **explicit consent** — revFADP Art. 6 para. 7 (_"The consent must be explicitly given for: a. processing sensitive personal data"_) and GDPR Art. 9(2)(a).

- **DPIA (revFADP Art. 22 / GDPR Art. 35)** is triggered by _"large-scale processing of sensitive personal data"_. A consented gallery of under 50 people is very likely below that bar — but Art. 22 para. 2 makes it a judgement call, so write the assessment down rather than assume it.
- **Disclosure to a third party.** revFADP Art. 30 para. 2 lit. c names disclosure of sensitive data to third parties as a breach of personality. Sending face crops to AWS is a disclosure needing its own basis and a processor agreement. **Keeping the gallery on meco's own container avoids this analysis entirely** — a genuine legal argument for the local-model route, independent of cost, and it also sidesteps the Zurich-region gap.
- **EU AI Act Art. 5(1)(e)** prohibits _"AI systems that create or expand facial recognition databases through the untargeted scraping of facial images from the internet or CCTV footage."_ Enrolling consenting family and team members from their own photos is targeted and consented — not caught. **Never build the gallery by scraping.** Art. 5(1)(h)'s real-time remote biometric identification ban is scoped to law enforcement in publicly accessible spaces and does not apply.
- **The household exemption evaporates for a business.** revFADP Art. 2 para. 2 lit. a and GDPR Art. 2(2)(c) exempt purely personal use; a deployed service serving brands is not that.

Practical rules to build in:

1. Explicit, recorded, per-purpose consent from every enrolled person; guardians consent for minors.
2. Store embeddings, delete reference photos after enrolment. Embeddings are still biometric personal data — this is minimisation, not exemption.
3. **Every other face in a group photo is also processed.** Compute non-gallery embeddings in memory only, never persist them, never log them, never write "unknown face" vectors to disk or to a cloud collection. This is the most overlooked exposure in a design like this.
4. Wire a real delete path — gallery entry, all vectors, cached crops — not a soft flag. revFADP Art. 6 para. 4 requires destruction once no longer needed.

---

## Q5 — Method family 4: custom objects and the driver's head

Two sub-problems: find _our_ kart, then find the head on it.

### Open-vocabulary detection — attractive, and not viable here

| Model                 | Licence                                 | Smallest usable ONNX          | Notes                                                 |
| --------------------- | --------------------------------------- | ----------------------------- | ----------------------------------------------------- |
| OWL-ViT b/32          | Apache-2.0                              | 127.3 MB q4f16                | 768×768 input                                         |
| OWLv2 b/16-ensemble   | Apache-2.0                              | 128.4 MB q4f16                | 960×960 input                                         |
| Grounding DINO Swin-T | Apache-2.0                              | 151.1 MB q4f16                | 48.4 COCO zero-shot AP                                |
| Florence-2-base       | MIT                                     | ~201 MB q4f16 across 4 graphs | autoregressive — seconds, not ms                      |
| YOLO-World            | ❌ **GPL-3.0**                          | —                             | ruled out                                             |
| YOLOE                 | ❌ **AGPL-3.0**                         | —                             | ruled out                                             |
| T-Rex2                | ❌ **IDEA License 1.0, non-commercial** | —                             | ruled out, and it is the one that does visual prompts |

**The feature that made OWL-ViT attractive does not exist in JavaScript.** OWL-ViT's paper claims _"one-shot image-conditioned object detection"_ — showing it a photo of _our_ kart instead of typing a prompt. That is `image_guided_detection` in Python. Transformers.js ships OWL-ViT as a five-line stub class with no methods, and a code search for `image_guided` across the whole repo returns zero hits. Text-prompted zero-shot works in Node; image-prompted does not. Revisit only if a Python sidecar ever exists.

Even text-prompted, these are 127–151 MB at 768–960 px input with **no published CPU latency anywhere**. Not a per-request path on scale-to-zero.

### Fine-tuning a small detector — the right answer

| Model                 | Licence         | Params  | ONNX (fp32 / q4f16)         | COCO AP   |
| --------------------- | --------------- | ------- | --------------------------- | --------- |
| **D-FINE-N** ← chosen | **Apache-2.0**  | **4 M** | **15.26 / 5.97 MB**         | 42.8      |
| RF-DETR-Nano          | **Apache-2.0**  | 30.5 M  | ONNX size **not published** | 48.4      |
| RT-DETR R18           | Apache-2.0      | 20 M    | 82.6 / 21.7 MB int8         | 46.5      |
| DETR R50              | Apache-2.0      | 41.6 M  | 166.8 / 58.5 MB             | 42.0      |
| YOLOv8/11             | ❌ **AGPL-3.0** | —       | —                           | 37.3–51.5 |

**D-FINE-N wins on size and on decode surface, not on accuracy.** It is 4 M params against RF-DETR-Nano's 30.5 M, ships pre-exported at **15,258,358 B fp32 / 5,966,346 B q4f16** as `onnx-community/dfine_n_coco-ONNX`, and — decisively — **does its own postprocessing inside the graph**. `src/zoo/dfine/postprocessor.py` is traced into the export, so the outputs are `labels` (int), `boxes` (**xyxy, absolute pixels**) and `scores` (**already sigmoid'd**), top-300, no NMS. The TypeScript side is a threshold-and-map loop.

RF-DETR hands back raw tensors and two documented silent-failure modes. Its docs: _"The exported graph returns raw tensors — `dets` (`pred_boxes`, normalized `cxcywh`) and `labels` (`pred_logits`, un-activated). Nothing is decoded inside the graph."_ And the warning that matters: **RF-DETR allocates `num_classes + 1` logit slots, so at `num_classes == 3` the logits tensor's last dimension is `4` — identical to the box tensor's.** Disambiguating by shape instead of by name silently swaps boxes and logits at exactly that class count and works fine at every other. Its own sample carries the comment `# Match outputs by name — do NOT assume positional order or infer role from shape.` The background slot is also checkpoint-dependent. Both are bugs that ship green.

On accuracy RF-DETR is genuinely ahead — 48.4 COCO AP to D-FINE-N's 42.8, and Roboflow's `model.export()` is friendlier than editing YAML and running `torchrun`. **If a pilot shows 42.8-class accuracy cannot find a kart reliably, RF-DETR-Nano is a safe fallback**: its opset-17 export contains ~6 `GridSample` nodes from the deformable attention, and the ORT CPU EP registers a `GridSample` kernel for opsets **16–19**, so there is no op-support blocker. `docs/OperatorKernels.md` showing only `GridSample 22+` for CPU is misleading — its generator prints only the newest registration; the source is authoritative. A sweep of the RF-DETR issue tracker for unsupported ops returns zero hits; every CPU issue is a _speed_ complaint, and the maintainers say so on the record: _"Transformer models do not generally play nice with CPU."_

**Two hard constraints either way.** Stay on `dfine_n_coco` — it is the only D-FINE size with no Objects365 lineage, and the README warns Objects365-pretrained checkpoints _"may be subject to the Objects365 dataset terms and should not be assumed to be commercially cleared under the D-FINE license"_ while simultaneously recommending them for fine-tuning. And **train from COCO weights, not the recommended Objects365 ones.**

Two D-FINE gotchas for the implementation: `remap_mscoco_category` is skipped in deploy mode, so `labels` are contiguous index positions rather than COCO category IDs; and the shipped `onnx_inf.py` letterboxes while training and eval **stretch-resize**, which an open issue reports causes _"a severe accuracy drop"_. Use stretch resize, rescale to `[0,1]`, and apply **no** ImageNet mean/std.

**Ultralytics is out on licence**, not preference. Its own licence page names _"SaaS platforms, APIs, or cloud systems that use YOLO behind the scenes"_ and _"custom-trained or fine-tuned YOLO models in a proprietary or commercial setting"_ as Enterprise triggers, and the Enterprise price is quote-only.

**Unverified and important: no primary source states a minimum dataset size.** RF-DETR's docs state no minimum; HF notes fine-tuning _"will require at least one GPU"_. Assume a rented GPU hour, not a laptop.

**Roboflow** as a hosted option: `roboflow/inference` has a per-directory licence mix (core Apache-2.0; `inference/models/yolov5|8|10|11|12` are **AGPL-3.0**; `yolov9`/`yolo_world` GPL-3.0; `rfdetr`/`owlv2`/`grounding_dino` Apache-2.0). Self-hosted inference is 1 credit per 3,000 images — effectively free at meco's volume; the spend is GPU training time at 1 credit per 30 minutes. There is **no real Node SDK** — use plain `fetch` against `serverless.roboflow.com`. Response predictions use **centre** `x`/`y` in absolute pixels.

### Pinning the driver's head

| Option                        | Licence                                    | Size                          | Node CPU                     | Helmet-safe                               |
| ----------------------------- | ------------------------------------------ | ----------------------------- | ---------------------------- | ----------------------------------------- |
| **RTMPose-t** (ONNX) ← chosen | Apache-2.0                                 | 13.35 MB                      | **6.32 ms measured**         | ✅ best measured helmet confidence        |
| RTMPose-s (ONNX)              | Apache-2.0                                 | 21.89 MB                      | 8.70 ms measured             | ✅ same code, +3.8 COCO AP                |
| MoveNet Thunder (ONNX)        | Apache-2.0                                 | 25.07 MB                      | 14.41 ms measured            | ✅ but head scores collapse on rear views |
| MoveNet Thunder (tfjs + WASM) | Apache-2.0                                 | 12.1 MB + **83.4 MB of tfjs** | ~42 ms measured              | ❌ second runtime, unmaintained stack     |
| MoveNet Lightning (ONNX)      | Apache-2.0                                 | 9.41 MB                       | 5.29 ms measured             | ✅ lower confidence still                 |
| RTMO-s (one-stage)            | Apache-2.0                                 | 39.62 MB                      | **80.43 ms measured**        | ❌ 13× too slow                           |
| ViTPose-S                     | repo Apache-2.0, **HF weights unlicensed** | 97.3 MB                       | no CPU numbers               | ❌ size + licence                         |
| MediaPipe Pose Landmarker     | model licence unstated                     | 5.8–30.7 MB                   | ❌ `document is not defined` | n/a                                       |
| YOLO11n-pose                  | ❌ AGPL-3.0                                | 11.9 MB                       | —                            | licence-blocked                           |
| Meta `sapiens`                | ❌ CC BY-NC 4.0                            | —                             | —                            | licence-blocked                           |

**RTMPose-t is the pick, and it beat MoveNet on the exact case that matters.** Both models were run over Creative-Commons karting photos from Wikimedia with a driver bounding box, which is the shape of input meco's kart detector produces:

| Case                        | RTMPose-t nose / L_ear / R_ear | MoveNet Thunder nose / L_ear / R_ear |
| --------------------------- | ------------------------------ | ------------------------------------ |
| Rear view, full-face helmet | **0.29 / 0.50 / 0.55**         | 0.05 / 0.17 / 0.05                   |
| Front view, driver "51"     | **0.58 / 0.53 / 0.71**         | 0.23 / 0.36 / 0.49                   |
| Front view, driver "20"     | **0.55 / 0.56 / 0.56**         | 0.38 / 0.16 / 0.42                   |

Both place the keypoints on the helmet, and agree on position to within ~2–20 px. The difference is confidence. On the rear view MoveNet's head scores fall to 0.05–0.17, **below Google's own recommended 0.3 threshold**, so a naive threshold discards the head entirely. RTMPose-t holds 0.29–0.55 on the same crop.

This is the opposite of what the model cards predict, which is worth stating plainly. **MoveNet's card carries the only occlusion guarantee in the field** — _"predicts 17 human keypoints of the full body even when they are occluded"_ — while **RTMPose's paper and README say nothing about occlusion at all.** The empirical result outranks the marketing copy, but the sample is three photos from one photographer in daylight. Validate on real Swiss Hutless footage before committing.

**Model and licence.** MMPose is Apache-2.0 (`LICENSE`, © 2018-2020 OpenMMLab; README: _"This project is released under the Apache 2.0 license."_). The ONNX is an official MMDeploy SDK export at a stable primary URL:

```
https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/
  rtmpose-t_simcc-body7_pt-body7_420e-256x192-026a1439_20230504.zip   # 12,547,710 B
  rtmpose-s_simcc-body7_pt-body7_420e-256x192-acd4a1ef_20230504.zip   # 20,496,303 B
```

`end2end.onnx` inside is 13,350,364 B (t) and 21,890,172 B (s). Verified loading and running under `onnxruntime-node@1.29.0`: input `[1,3,256,192]` float32, outputs `simcc_x [1,17,384]` and `simcc_y [1,17,512]`, no missing ops. Note the downloadable ONNX are the **body7** variants, whose COCO AP is **65.9 (t) / 69.7 (s)** — lower than the 68.5 / 72.2 in the README's headline table, which covers AIC+COCO variants shipped as `.pth` only.

**Top-down is free here.** `deploy.json` declares `"task": "PoseDetector"`, `"name": "topdownposeestimator"`, and the preprocessing chain is `TopDownGetBboxCenterScale(padding=1.25)` → `TopDownAffine([192,256])` → `Normalize(ImageNet mean/std, to_rgb=true)`. It wants a bbox-cropped input, and the kart detector already produces one. Feed it the kart crop padded to include the torso, never a tight head crop.

**The decode is ~60 lines** and skips the two fiddly parts: `pipeline.json` sets `use_dark: false` and `flip_test: false`, so no DARK refinement and no flip test. Steps: bbox → centre/scale with `padding=1.25`, fix aspect to 3:4, crop and resize to 192×256 (pad out-of-bounds boxes — sharp's `extract` throws on them), ImageNet normalise RGB CHW, then argmax over `simcc_x` and `simcc_y` with `score = min(max_x, max_y)` and `coord = idx / 2.0` (`simcc_split_ratio`), then affine back to image pixels.

**MoveNet stays as the de-risking step, not the destination.** `Xenova/movenet-singlepose-thunder` publishes a `tf2onnx 1.16.1` export (25,067,197 B, Apache-2.0) whose I/O is `input int32 [1,256,256,3]` raw 0–255 NHWC → `output_0 float32 [1,1,17,3]` as `y, x, score` normalised. That is byte-identical in shape to what tfjs returns, so it removes all 83.4 MB of TensorFlow.js with **zero model-behaviour change and zero new decode code**. Ship that first if you want the runtime migration and the model swap to be separately attributable. Do not int8-quantise it — the quantised build measured 31.83 ms against 14.41 ms for fp32.

Head centre from keypoints:

```
headCentre = Σ(score_i · p_i) / Σ(score_i)   over {nose, left_eye, right_eye, left_ear, right_ear}
headWidth  ≈ |left_ear.x − right_ear.x|      // crop-scale proxy
```

Fall back to the shoulder midpoint offset upward when every head score is low.

**Dedicated head detectors are licence-blocked.** CrowdHuman: _"You will use the data only for non-commercial research and educational purposes."_ SCUT-HEAD: _"free to the academic community for research purpose usage only."_ This taints every CrowdHuman-trained head detector, including permissively-tagged Hugging Face re-uploads. **No racing or kart helmet detector exists on Hugging Face.** Pose estimation is the answer here, not head detection.

### Vision language models — for labelling, not framing

| Provider   | Documents boxes?  | Format                                                                       | Own accuracy caveat                                             |
| ---------- | ----------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Gemini** | ✅ prominently    | `box_2d: [ymin, xmin, ymax, xmax]` **normalised 0–1000**, plus polygon masks | none stated                                                     |
| **Claude** | ✅ dedicated page | **absolute pixels**; normalised 0–1000 explicitly discouraged                | _"coordinate and localization outputs are approximate"_         |
| **OpenAI** | ❌ not documented | —                                                                            | _"struggles with tasks requiring precise spatial localization"_ |

Gemini's docs are unambiguous: _"The box_2d should be `[ymin, xmin, ymax, xmax]` normalized to 0-1000."_ Segmentation adds a mask polygon in the same space.

Claude's coordinate contract is the **opposite convention** and is worth quoting because getting it backwards silently degrades results: _"Claude works best with absolute pixel coordinates. Ask for them explicitly in your prompt … Claude does not work well when you ask for normalized coordinates, for example: 'Return bounding box coordinates between 0 and 1000.' Always ask for pixel coordinates and normalize in your own code."_ Coordinates are relative to the image **after Claude's server-side resize**, so pre-resize with the documented helper or rescale afterwards; `transformations: {"oversized_image": "error"}` on the image block turns a silent resize into a 400. Cost is `⌈width/28⌉ × ⌈height/28⌉` visual tokens (standard tier caps at 1568 px edge / 1568 tokens; high-resolution tier 2576 px / 4784 tokens) — a 1920×1080 photo resizes to 1456×819 = 1,560 tokens, so at Claude Haiku 4.5's $1/MTok input that is roughly **$1.60 per thousand images** before output tokens.

**The blunt verdict:** the published grounding numbers do not support driving a Crop. PointArena puts Gemini-2.5-Pro and Molmo-72B near 57% and GPT-4o near 42–46% on _pointing_ — an easier task than a tight box. UWBench measures GPT-4o at 36.78% mean IoU. LLM-Optic's whole architecture is an admission of the problem: it never asks the model for coordinates, it draws numbered marks on detector-proposed boxes and asks the model to pick a number.

**Where a vision model earns its place: labelling the 100–500 training images for the kart detector, offline.** That is a real cost saving and a real time saving, and mistakes there get caught in review rather than shipped as a decapitated Instagram post.

---

## Q6 — The placement algorithm

This is the part meco has to write itself. Everything above only produces inputs to it.

### The unifying idea

**A Subject Area is a target rectangle expressed in fractions of the output frame.** The golden-ratio grid is just a _default_ Subject Area. So there is exactly one solver, and Templates that declare a Subject Area and Crops that do not both go through it.

That means `SubjectArea` in `src/crop.ts` stops being a dead interface and becomes the centre of the module.

### Inputs

```ts
/** Where a Subject sits in a Source Image. Fractions, 0..1 from the top-left. */
interface SubjectBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Higher wins the anchor. Recognised person > face > object > saliency point. */
  priority: number;
  /** Must survive the Crop. A recognised face is true; background faces are false. */
  keep: boolean;
  /** Optional eye midpoint, fraction of the Source Image. Drives headroom. */
  eyeY?: number;
}
```

Producers, in resolution order — the first that yields a box wins the anchor, later ones still contribute to containment:

1. Human override (a stored annotation, see Q7)
2. Recognised person
3. Detected face (largest, or all)
4. Detected object (the branded kart) with a pose-derived head inside it
5. Saliency: sharp's attention-strategy point (Q2) as a zero-extent box
6. Crop Anchor (today's behaviour), mapped to a point
7. Centre

### Constants

```ts
const PHI_INV = 0.6180339887498949; // 1/φ
const PHI_LINES = [1 - PHI_INV, PHI_INV]; // 0.381966…, 0.618034…
const THIRDS = [1 / 3, 2 / 3];
```

### Step 1 — anchor point

With one Subject, the anchor is its centre. With several, use Thumbor's weighted centroid — the cleanest documented focal-points-to-point math in this survey:

```
P.x = Σ(w_i · centre_i.x) / Σ w_i
P.y = Σ(w_i · centre_i.y) / Σ w_i        where w_i = priority_i × area_i
```

Exception: if any Subject has the top priority tier (a recognised person), **that box alone is the anchor**. The others only enter the containment test. This is what "in a group photo it pins the subject on our face" means concretely.

### Step 2 — crop window size

Let the Source Image be `Wₛ × Hₛ` and the required aspect `a = W_t / H_t`. The cover window at zoom 1:

```
if (Wₛ / Hₛ > a)  cw = Hₛ · a,  ch = Hₛ
else              cw = Wₛ,      ch = Wₛ / a
```

Zoom tightens it: `cw /= z`, `ch /= z`, with `z ≥ 1`. This is the same knob as imgix `fp-z` and Cloudinary `z_`, whose docs describe it as _"how close to crop to the detected coordinates."_

**When a Template declares a Subject Area, the zoom is not free — it is solved.** The Subject Area `SA = {x, y, width, height}` says the Subject must fill that fraction of the Image Slot, so:

```
cw_required = subjectWidthPx  / SA.width
ch_required = subjectHeightPx / SA.height
cw = max(cw_required, ch_required · a)      // whichever constraint binds
ch = cw / a
```

Clamp `cw ≤ Wₛ` and `ch ≤ Hₛ`. If the required window exceeds the Source Image, the Subject is too small in the original to fill the Subject Area at this shape — that is a legitimate failure to report, not something to silently fudge.

### Step 3 — target position inside the frame

Without a Subject Area, pick the phi line **nearest to where the anchor already sits** in the natural cover window. That minimises the shift, keeps the photographer's framing, and makes clamping less likely:

```ts
const nearest = (v: number, lines: number[]) =>
  lines.reduce((best, l) => (Math.abs(l - v) < Math.abs(best - v) ? l : best));

const naturalFx = (P.x - cover.left) / cover.width;
const fx = nearest(naturalFx, PHI_LINES);
let fy = nearest(naturalFy, PHI_LINES);
```

With a Subject Area, the target is simply its centre: `fx = SA.x + SA.width/2`, `fy = SA.y + SA.height/2`.

**Headroom rule for faces.** For a face or head Subject, the eye line — not the box centre — goes on the **upper** phi line. Portrait convention, and it is what stops a Crop putting a forehead in the middle of the frame:

```ts
if (subject.kind === "face") {
  fy = PHI_LINES[0]; // 0.382, upper line
  P.y = subject.eyeY ?? subject.y + 0.42 * subject.height;
}
```

Use the real eye midpoint when the detector gives landmarks — YuNet returns right eye and left eye, so this is available from v2 onward. The `0.42` fallback is a convention, not a sourced constant.

### Step 4 — solve and clamp

```
L = P.x − fx · cw
T = P.y − fy · ch
L = clamp(L, 0, Wₛ − cw)
T = clamp(T, 0, Hₛ − ch)
```

This is the same centre-and-clamp shape libvips and Thumbor both use, generalised from `fx = fy = 0.5` to an arbitrary target. libvips: `*left = VIPS_CLIP(0, *attention_x - width/2, in->Xsize - width)`. Thumbor: `crop_left = min(max(focal_x - crop_width/2, 0.0), source_width - crop_width)`.

### Step 5 — containment and fallbacks

Let `U` be the union of every Subject box with `keep: true`. Test `U ⊆ {L, T, cw, ch}`. If it fails, in order:

1. **Zoom out** — reduce `z` toward 1, re-solve. Cheapest fix and usually sufficient.
2. **Relax the target** — slide `fx`/`fy` toward 0.5. The Subject stays in frame; the composition degrades gracefully.
3. **Drop the lowest-priority Subject** from `keep` and retry. In a group photo this is how a background face gets sacrificed for a recognised one.
4. **Give up gracefully** — centre on `U`'s centroid, accept clipping on the least important axis, and report it.

Every branch must be reflected in the result. Extend `CropResult.resolvedBy` from `"anchor" | "strategy"` to name the producer and the outcome — `"recognised-person"`, `"face"`, `"object"`, `"saliency"`, `"anchor"`, `"centre"` — plus a flag for whether the Subject Area was satisfied. `src/crop.ts` already calls this field _"What actually decided the framing, for the response and for debugging."_ That instinct is right and gets more valuable as producers multiply.

### Why analytic, not search-based

smartcrop.js scores a sliding window; libvips takes an argmax. Both are search. The solver above is closed-form:

- **Deterministic and unit-testable.** Given a Subject box and an aspect, the crop window is a pure function. No 32×32 quantisation, no `step: 8` stride, no scoring weights to tune.
- **It satisfies the Subject Area exactly**, which a scorer can only approximate.
- **It composes.** Adding a new detector adds a producer, not a new scoring term.

This is also why `smartcrop`'s boost mechanism is not needed. Boosting exists to make a known region win a _search_; the solver does not search, it solves. A detected face enters as a high-priority Subject box and the crop window follows from it directly.

---

## Q7 — Storing the annotation

### The standard: IPTC Image Region

`Iptc4xmpExt:ImageRegion`, IPTC Photo Metadata Standard 2025.1 §11.20, added in Extension 1.5 (2019.1). Namespace `http://iptc.org/std/Iptc4xmpExt/2008-02-29/`, ExifTool group `XMP-iptcExt`.

A region is `{ RegionBoundary (mandatory), rId, Name, rCtype[], rRole[], any nested IPTC property }`. The boundary is `{ rbShape ∈ rectangle|circle|polygon, rbUnit ∈ pixel|relative, rbX, rbY, rbW, rbH, rbRx, rbVertices }`, with `rbShape` and `rbUnit` both mandatory. Rectangle `rbX/rbY` is the **upper-left corner**; circle `rbX/rbY` is the **centre**.

**The role vocabulary is meco's Subject Area concept, already standardised.** `http://cv.iptc.org/newscodes/imageregionrole/` contains: `cropping`, `recomCropping`, `landscapeCropping`, `portraitCropping`, `squareCropping`, **`subjectArea`**, **`mainSubjectArea`**, `areaOfInterest`, `compositeImageItem`, `copyrightRegion`, `anonymised`, `recommendedAnonymisation`, `businessUse`. There is **no `landmark` role** — do not plan for one. The content-type vocabulary at `imageregiontype/` includes `human`, `vehicle`, `product`, `animal`, `text`, `machineCode`.

IPTC's own user guide states the intent in almost exactly meco's words: _"Suggestions for how the image could be cropped to accommodate different layouts can now be embedded into the image itself. For example, you could mark a horizontal rectangle within a vertical image and indicate that the role for this marked area is a 'landscape format cropping' for that image."_

From IPTC's own published example file:

```xml
<Iptc4xmpExt:ImageRegion><rdf:Bag><rdf:li rdf:parseType='Resource'>
  <Iptc4xmpExt:rId>persltr2</Iptc4xmpExt:rId>
  <Iptc4xmpExt:Name><rdf:Alt><rdf:li xml:lang='x-default'>Listener 1</rdf:li></rdf:Alt></Iptc4xmpExt:Name>
  <Iptc4xmpExt:PersonInImage><rdf:Bag><rdf:li>Brendan Quinn</rdf:li></rdf:Bag></Iptc4xmpExt:PersonInImage>
  <Iptc4xmpExt:RegionBoundary rdf:parseType='Resource'>
    <Iptc4xmpExt:rbShape>rectangle</Iptc4xmpExt:rbShape>
    <Iptc4xmpExt:rbUnit>relative</Iptc4xmpExt:rbUnit>
    <Iptc4xmpExt:rbX>0.33</Iptc4xmpExt:rbX>
    <Iptc4xmpExt:rbY>0.34</Iptc4xmpExt:rbY>
    <Iptc4xmpExt:rbW>0.105</Iptc4xmpExt:rbW>
    <Iptc4xmpExt:rbH>0.2</Iptc4xmpExt:rbH>
  </Iptc4xmpExt:RegionBoundary>
  <!-- rCtype -> imageregiontype/human ; rRole -> imageregionrole/subjectArea -->
</rdf:li></rdf:Bag></Iptc4xmpExt:ImageRegion>
```

**Always `rbUnit=relative`.** The spec's implementation note: _"If the unit 'pixel' is used: in case of rescaling the image the coordinate values and the radius of a circle must be rescaled too."_ Relative coordinates survive a resize untouched. They do not survive a _crop_ — IPTC warns about that too, which is why derivatives should drop regions rather than copy them verbatim.

### How CMSs model the same thing

| System               | Field                                                             | Coordinate space                                   | Anchor           |
| -------------------- | ----------------------------------------------------------------- | -------------------------------------------------- | ---------------- |
| **IPTC ImageRegion** | `RegionBoundary{rbShape, rbUnit, rbX, rbY, rbW, rbH}`             | `relative` 0–1 **or** `pixel`, declared per region | rect: top-left   |
| **Sanity**           | `hotspot{x, y, width, height}` + `crop{top, bottom, left, right}` | fraction 0–1 of the asset                          | **x/y = centre** |
| **Payload**          | `focalX`, `focalY`                                                | **percent 0–100**                                  | point            |
| Contentful           | `f=center                                                         | top                                                | face             | faces | …`  | none | named area |
| Storyblok            | `focus: "X1xY1:X2xY2"`                                            | pixels, two corners                                | corners          |
| Cloudinary           | `custom_coordinates: "x,y,w,h"`, `g_auto:aoi_x_y_w_h`             | pixels                                             | top-left         |
| WordPress            | `focalPoint{x, y}`                                                | fraction 0–1                                       | point            |

**Sanity is the best prior art** because it is the only one storing a _region with a centre_ rather than a bare dot or a bare box. A dot tells you where to aim; the box tells you how much you must not cut. meco needs both — that is exactly the `SubjectBox` shape in Q6. Its algorithm is also the one to copy: fractions become pixel rects against the asset, then when both width and height are requested it trims the crop rect on the over-long axis and centres the output window on the hotspot centre, clamped inside the crop rect.

Payload's is the simplest working focal-point pipeline in sharp: percent to pixels, resize to cover, centre the target box on the focal point, clamp, `.extract()`.

Contentful is the cautionary tale — its focal-point _app_ stores absolute pixels that its own Images API cannot consume, a mismatch its own issue tracker records.

### sharp's XMP capability, precisely

- **Default is strip.** _"By default all metadata will be removed."_ A plain resize drops the XMP packet — which is correct for a derivative whose region coordinates would otherwise be lies.
- `keepXmp()` preserves it; `withXmp(xmp)` **sets** it, added in **sharp 0.34.3 (10 July 2025)**, PNG/JPEG/WebP/TIFF output only.
- Read side: `metadata().xmp` (Buffer) and `metadata().xmpAsString`.
- **sharp cannot parse, edit or rewrite region coordinates.** It moves XMP as an opaque blob. Any coordinate-aware write needs ExifTool or hand-built XMP.

`exiftool-vendored@37.2.0` (MIT, ~133k weekly downloads) bundles `exiftool-vendored.pl@13.59.2` — 21.6 MB, and **it bundles the Perl scripts, not a Perl interpreter**. Its own installation doc is explicit: _"✅ Good - includes perl `FROM node:24` … ❌ Bad - missing perl `FROM node:24-slim`"_. meco is on `node:24-slim`, so embedding XMP costs `apt-get install -y perl` (~35 MB) in `Dockerfile.vercel`, and ExifTool must stay off the request path.

### Recommendation

**Own storage is the system of record; embedded XMP is a projection written on export.** This is darktable's stance too — its docs frame the sidecar as _"a redundant method of saving the changes"_ with the database primary.

```jsonc
{
  "schema": "iptc.imageRegion/1",
  "appliedToDimensions": { "w": 4000, "h": 3000 }, // borrowed from XMP-mwg-rs: what the coords were measured against
  "regions": [
    {
      "rId": "subj-1",
      "name": "Anna",
      "regionBoundary": {
        "rbShape": "rectangle",
        "rbUnit": "relative",
        "rbX": 0.33,
        "rbY": 0.34,
        "rbW": 0.105,
        "rbH": 0.2,
      },
      "rCtype": [
        {
          "identifier": ["http://cv.iptc.org/newscodes/imageregiontype/human"],
        },
      ],
      "rRole": [
        {
          "identifier": [
            "http://cv.iptc.org/newscodes/imageregionrole/mainSubjectArea",
          ],
        },
      ],
      // meco's own provenance, kept out of the XMP projection
      "source": "detector:yunet@2026-09-02",
      "confidence": 0.94,
      "overriddenBy": null,
      "overriddenAt": null,
    },
  ],
}
```

Four rules that fall out of it:

1. **The human override is a second region, not a mutation.** Write it with its own role, mark it authoritative in meco's own fields, and never overwrite the machine annotation — you want to re-run the detector and diff.
2. **Per-shape overrides use the cropping roles.** `landscapeCropping` / `portraitCropping` / `squareCropping` exist precisely for "here is the Crop I want for this shape", distinct from `mainSubjectArea`'s "here is where the Subject is".
3. **The focal point is derived, never stored separately** — `rbX + rbW/2`, `rbY + rbH/2`. One source of truth.
4. **Embed on export only.** Never on the request path, and never copy regions verbatim onto a cropped derivative.

For a human override UI: nothing on npm is both permissively licensed and a pure focal-dot picker. `react-image-crop` (ISC, ~2.5M weekly) handles the box-drawing half; a dot picker is ~80 lines of positioned div plus pointer events. WordPress's `FocalPointPicker` is the only true dot picker and is GPL-2.0+.

---

## Stack after the EdgeFace decision

Choosing EdgeFace put `onnxruntime-node` in the image unconditionally. Re-running every other component against "does this justify a second runtime" removes three of them, and every removal also removes a maintenance liability. The net is **one runtime, four models, two npm dependencies.**

### The whole plan, as dependencies

| Package / artifact                     | Version    | Runtime                  | Image Δ                                           | Licence                                   | Phase                                        |
| -------------------------------------- | ---------- | ------------------------ | ------------------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| `sharp`                                | 0.35.4     | native (already present) | 0                                                 | Apache-2.0                                | v1 — saliency, decode, and the ArcFace warp  |
| `onnxruntime-node`                     | 1.29.0     | native                   | **45 MB** pruned to `linux/x64` (296 MB unpruned) | MIT                                       | v2                                           |
| `face_detection_yunet_2026may.onnx`    | 2026may    | ORT                      | 229,738 B                                         | **MIT**                                   | v2 — faces                                   |
| EdgeFace `edgeface_xs_gamma_06`        | —          | ORT                      | ~7 MB, exported offline                           | ⚠ code BSD-3, **weights CC BY-NC-SA 4.0** | v3 — known people                            |
| `rtmpose-t_simcc-body7 … end2end.onnx` | 20230504   | ORT                      | 13,350,364 B                                      | Apache-2.0                                | v3′ — driver's head                          |
| `onnx-community/dfine_n_coco-ONNX`     | 2025-04-30 | ORT                      | 15,258,358 B fp32 / 5,966,346 B q4f16             | Apache-2.0                                | v3′ — the kart                               |
| `exiftool-vendored`                    | 37.2.0     | Perl subprocess          | 21.6 MB + `apt install perl`                      | MIT                                       | annotation export only, off the request path |

Everything above `exiftool-vendored` is the request path. **Total added to the container for the full v3′ stack: ~45 MB of runtime plus ~36 MB of models.** For comparison, the previous plan needed ONNX Runtime _plus_ `@techstark/opencv-js` (14.7 MB) _plus_ the TensorFlow.js tree (83.4 MB) — three runtimes and ~143 MB, to run models totalling less.

### What was dropped, and why

| Dropped                                                    | Replaced by                                                 | Reason                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@techstark/opencv-js`                                     | YuNet as a raw ONNX graph                                   | Second runtime for one model ORT already runs. Costs ~150 lines of decode.                                                      |
| `@tensorflow/tfjs-*` + `@tensorflow-models/pose-detection` | RTMPose-t ONNX                                              | Third runtime, 83.4 MB, **and the least maintained thing in the plan**. RTMPose-t is also faster and more confident on helmets. |
| OpenCV for face alignment                                  | `sharp.affine()` + 20 lines of closed-form similarity       | Verified to 0.17 px. No dependency at all.                                                                                      |
| `smartcrop` + `smartcrop-sharp`                            | `sharp`'s saliency point (Q2), then real face boxes from v2 | Fails the maintenance check. The boost mechanism has no job once the solver is analytic.                                        |
| RF-DETR-Nano                                               | D-FINE-N                                                    | 8× the parameters, ONNX size unpublished, raw outputs with two silent-failure modes. Kept as the accuracy fallback.             |
| MoveNet + tfjs                                             | RTMPose-t                                                   | See above. MoveNet ONNX remains available as a de-risking step.                                                                 |

### Engineering cost of going runtime-single

Roughly **210 lines of decode**, written once, against three fewer runtimes and three fewer maintenance liabilities:

| Component            | Lines | What you write                                                                      |
| -------------------- | ----- | ----------------------------------------------------------------------------------- |
| YuNet decode         | ~150  | Per-stride anchor loop, `sqrt(cls·obj)`, bbox and landmark decode, greedy NMS       |
| RTMPose SimCC decode | ~60   | Centre/scale, 3:4 aspect fix, ImageNet normalise, argmax over two axes, affine back |
| ArcFace alignment    | ~20   | Closed-form similarity fit, `oarea` prediction, buffer slice                        |
| D-FINE decode        | ~5    | Threshold and map — the graph already did the rest                                  |

The RTMPose decode skips DARK refinement and flip test (`use_dark: false`, `flip_test: false` in its own `pipeline.json`), which is the fiddly part of most pose decoders.

## Maintenance check (3 Sep 2026)

Rule applied: **NOT MAINTAINED** if the repo is archived, or has no push in more than 18 months (cutoff ~Mar 2025). npm dates are `time.modified`; repo dates are `pushed_at` from the GitHub API.

| Package / repo                             | Latest          | npm published  | Repo pushed    | Open issues | Verdict                                                                       |
| ------------------------------------------ | --------------- | -------------- | -------------- | ----------- | ----------------------------------------------------------------------------- |
| `sharp` / lovell/sharp                     | 0.35.4          | 2026-08-26     | 2026-08-30     | 112         | ✅ maintained                                                                 |
| `onnxruntime-node` / microsoft/onnxruntime | 1.29.0          | 2026-09-02     | 2026-09-03     | 838         | ✅ maintained, ~monthly releases                                              |
| `exiftool-vendored`                        | 37.2.0          | 2026-08-08     | 2026-08-08     | **0**       | ✅ maintained, exemplary                                                      |
| `exiftool-vendored.pl`                     | 13.59.2         | 2026-08-08     | —              | —           | ✅ maintained                                                                 |
| `@huggingface/transformers`                | 4.2.0           | 2026-04-22     | 2026-09-03     | 195         | ✅ maintained                                                                 |
| opencv/opencv_zoo (YuNet weights)          | —               | n/a            | 2026-05-28     | 12          | ⚠️ commits current, **no release since 2024-06**                              |
| Tau-J/rtmlib                               | 0.0.16          | 2026-08-03     | 2026-08-03     | 23          | ✅ maintained                                                                 |
| roboflow/rf-detr                           | 1.9.4           | 2026-08-24     | 2026-09-02     | 74          | ✅ maintained                                                                 |
| `@techstark/opencv-js`                     | 5.0.0-release.1 | 2026-06-24     | 2026-08-01     | 25          | ✅ maintained (dropped for architecture, not health)                          |
| Peterande/D-FINE                           | none            | n/a            | 2026-08-19     | 153         | ⚠️ current, but **no tags at all — pin a commit SHA**                         |
| open-mmlab/mmpose (RTMPose)                | v1.3.2          | n/a            | 2025-08-04     | 301         | ⚠️ dormant: **no release in 26 months**                                       |
| otroshi/edgeface                           | none            | n/a            | 2025-08-07     | 0           | ⚠️ research code: no releases, no tags, `NOASSERTION`                         |
| `smartcrop` / jwagner/smartcrop.js         | 2.0.5           | **2021-09-01** | **2024-03-16** | 20          | ❌ **NOT MAINTAINED**                                                         |
| `smartcrop-sharp`                          | 2.0.8           | **2023-09-04** | **2023-09-04** | 4           | ❌ **NOT MAINTAINED**                                                         |
| `@tensorflow/tfjs*` / tensorflow/tfjs      | 4.22.0          | **2025-01-08** | 2026-06-23     | 37          | ❌ **no stable release in 22 months**; `4.23.0-rc.0` never shipped            |
| `@tensorflow-models/pose-detection`        | 2.1.3           | **2023-08-29** | 2026-06-23     | —           | ❌ **NOT MAINTAINED**                                                         |
| tensorflow/tfjs-models                     | —               | n/a            | 2026-06-23     | 0           | ❌ **issues disabled**, last release 2021, recent commits are Dependabot only |

**Four packages fail: `smartcrop`, `smartcrop-sharp`, `@tensorflow/tfjs*`, `@tensorflow-models/pose-detection`.** All four are removed by the changes above. Nothing in the final plan fails.

Two honest qualifications:

- **The tfjs repos are not dead, they are unreleased.** `tensorflow/tfjs` and `tfjs-models` were both pushed 2026-06-23 and neither is archived. But `@tensorflow-models/pose-detection@2.1.3` is the newest version that exists, from 2023, and `tfjs-models` has issues _disabled_ with recent commits that are Dependabot bumps. That is "no releases", not "abandoned" — and for a dependency in the request path, no releases is enough.
- **MMPose is dormant too** (no release in 26 months, 301 open issues), which looks like trading one stale dependency for another. It is not, and the distinction is the point of this migration: **an ONNX file is a static artifact vendored once.** The producer going quiet does not matter; only the _runtime_ has to stay alive, and that is ONNX Runtime, released monthly. Decoupling the model producer from the runtime is the structural win, and it applies equally to YuNet's opencv_zoo and to D-FINE.

## Licence summary — the decisions this forces

| Ruled out on licence                                        | Why                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| InsightFace SCRFD / RetinaFace / buffalo_l / antelopev2     | _"models trained with these data are available for non-commercial research purposes only"_ |
| Ultralytics YOLO (any version, any fork, fine-tuned or not) | AGPL-3.0; Enterprise licence explicitly required for SaaS/API deployment                   |
| YOLO-World                                                  | GPL-3.0                                                                                    |
| YOLOE                                                       | AGPL-3.0                                                                                   |
| T-Rex2                                                      | IDEA License 1.0, non-commercial                                                           |
| CrowdHuman / SCUT-HEAD head detectors                       | dataset terms are non-commercial                                                           |
| Azure AI Face identification                                | Limited Access, _"only to customers managed by Microsoft"_                                 |

| Cleared                                       | Licence                                                               |
| --------------------------------------------- | --------------------------------------------------------------------- |
| sharp / libvips smartcrop and affine          | Apache-2.0 / LGPL-2.1+                                                |
| YuNet weights                                 | MIT                                                                   |
| `onnxruntime-node`                            | MIT                                                                   |
| `@techstark/opencv-js` (dropped, not blocked) | Apache-2.0                                                            |
| RTMPose weights and MMPose code               | Apache-2.0                                                            |
| MoveNet, tfjs (dropped, not blocked)          | Apache-2.0                                                            |
| D-FINE, RF-DETR N/S/M/L, RT-DETR, DETR        | Apache-2.0                                                            |
| ONNX Model Zoo ArcFace                        | Apache-2.0 — the licence-clean fallback if EdgeFace cannot be cleared |
| exiftool-vendored                             | MIT                                                                   |

| ⚠ Cleared only conditionally  | Question                                                                                                                                                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EdgeFace weights**          | Code BSD-3, **published weights CC BY-NC-SA 4.0**. Blocks v3 until Idiap clarifies — see the risk box in Q4.                                                                                                                                                                       |
| RTMPose `body7` weights       | Apache-2.0 covers OpenMMLab's code and weights, but body7 trains on AI Challenger, COCO, CrowdPose, MPII, sub-JHMDB, Halpe and PoseTrack18, several of which carry research-only dataset terms. Whether that propagates to the derived weights is unresolved from primary sources. |
| D-FINE Objects365 checkpoints | _"may be subject to the Objects365 dataset terms"_. Avoided by using `dfine_n_coco` only.                                                                                                                                                                                          |
| RF-DETR PML 1.0               | The licence text itself is unobtainable — `roboflow/rf-detr-plus` 404s and PyPI reports `license: null`. Irrelevant while staying on N/S/M/L.                                                                                                                                      |

---

## Open questions and things not verified

**Must be measured, not cited:**

- **No vendor publishes a CPU latency benchmark for any of these models on the Node path.** The pose and alignment numbers in this doc — RTMPose-t 6.32 ms, RTMPose-s 8.70 ms, MoveNet Thunder ONNX 14.41 ms, RTMO-s 80.43 ms, the 3.8 ms alignment warp — were **measured during this research on an Apple M4 at `intraOpNumThreads: 1`**, not published by anyone. Neither RF-DETR nor D-FINE publishes any CPU figure at all; every number in their READMEs is NVIDIA T4 TensorRT FP16. **Re-measure everything in the actual Vercel container**: different architecture, different core count, different thermal envelope. This is still the single biggest unknown in the whole decision.
- The helmet-keypoint result is **three Wikimedia photos from one photographer in daylight**. It is the reason RTMPose was chosen over MoveNet, so it is load-bearing. Validate on real Swiss Hutless race photos before committing.
- Whether 100–500 labelled images suffices to fine-tune D-FINE or RF-DETR. No primary source states a minimum; Hugging Face notes fine-tuning _"will require at least one GPU"_. Assume a rented GPU hour.
- The ONNX-exported size and CPU latency of `edgeface_xs_gamma_06`. No official export exists, so both depend on how you run `torch.onnx.export`.
- One `require('onnxruntime-node')` smoke test in the real image. The glibc conclusions come from ELF headers and Debian package metadata, not from loading the module in a container.

**Unverified from primary sources:**

- imgix's `fp-x`/`fp-y`/`fp-z` crop-window formula and clamping — confirmed _absent_ from the docs, not merely unfound.
- **Which EdgeFace licence governs.** The GitHub LICENSE is verbatim BSD-3; the official Idiap model cards declare CC BY-NC-SA 4.0. Both are primary sources and they disagree. Only Idiap can settle it.
- **Whether RTMPose's `body7` training corpora propagate research-only terms** to the released weights. Apache-2.0 is declared on the code and the weights; several of the seven datasets are not permissive. Applies to any model trained on those corpora, not just this one.
- YuNet's _training_ pipeline channel order. What is confirmed is that OpenCV's reference implementation — the one that produced the published WIDER FACE numbers — feeds **BGR, 0–255**. That is what to match.
- **RF-DETR's PML 1.0 licence text** is unobtainable: the repo it should live in 404s, and PyPI reports `license: null` for `rfdetr-plus`.
- **The `onnx-community/dfine_*-ONNX` repos declare no licence** (`cardData.license: null`). Apache-2.0 is inherited only by `base_model` reference to `ustc-community/dfine_n_coco`. A supply-chain paperwork gap, not a known restriction.
- **`onnxruntime-node` has no `engines` field and Microsoft never states Node 24 support.** Compatibility rests on the Node-API v6 ABI guarantee, which is sound but is not a vendor claim.
- EdgeFace's training dataset is not named in the repo README.
- `@vladmandic/human` publishes **no** accuracy benchmark for its face-description model, and no per-model weight licence table — only _"inherited from the original model source."_
- InsightFace publishes **no** recommended cosine threshold anywhere.
- ExifTool's flattened tag names for `ImageRegion` — derived from the `FlatName` chain in source; `exiftool.org/TagNames/*` returned 404 throughout. Confirm locally with `exiftool -listx -XMP-iptcExt:all`. Write regions as structs, not flattened tags, regardless.
- XMP-mwg-rs `stArea.x/y` being the region **centre** and `unit` being `normalized` — the near-universal convention, but the MWG 2.0 PDF was not read.
- Whether social platforms still strip embedded XMP. IPTC's own test data is from **January 2016** and found 10 of 15 platforms stripping. Run a current test before relying on embedded regions surviving a post.
- AWS Rekognition EU pricing parity (the pricing page quotes US East only) and Azure Face per-transaction dollar figures.
- Storyblok's smart-crop detection engine is not named in any primary source.
- EUR-Lex blocks automated retrieval (HTTP 202 challenge). AI Act quotes come from the European Commission's official AI Act Service Desk; GDPR from gdpr-info.eu. Verify against EUR-Lex before publishing anything legal-facing.

**Design questions for meco specifically:**

- Do Templates declare a Subject Area now, or does the solver's phi-grid default carry v1 and v2 alone? Nothing in `src/templates/` declares one today.
- Does a Crop become cacheable by annotation? A stored Subject box plus an aspect ratio is a pure key — a Crop for a new Placement could reuse the annotation without re-running any detector. That is the strongest argument for own-storage annotation over per-request detection.
- Where does the enrolled-face gallery live given meco's current storage (`@vercel/blob`)? Embeddings are small, but they are sensitive personal data with a delete obligation.

---

## Sources

**sharp / libvips:** [sharp api-resize](https://sharp.pixelplumbing.com/api-resize) · [sharp api-output](https://github.com/lovell/sharp/blob/main/docs/src/content/docs/api-output.md) · [sharp pipeline.cc](https://github.com/lovell/sharp/blob/main/src/pipeline.cc) · [sharp v0.32.0 changelog](https://github.com/lovell/sharp/blob/main/docs/src/content/docs/changelog/v0.32.0.md) · [sharp v0.34.3 changelog](https://sharp.pixelplumbing.com/changelog/v0.34.3/) · [sharp resize-cover test](https://github.com/lovell/sharp/blob/main/test/unit/resize-cover.js) · [libvips smartcrop.c](https://github.com/libvips/libvips/blob/master/libvips/conversion/smartcrop.c) · [libvips extract.c](https://github.com/libvips/libvips/blob/master/libvips/conversion/extract.c) · [libvips smartcrop docs](https://www.libvips.org/API/current/method.Image.smartcrop.html) · [sharp api-operation (affine)](https://sharp.pixelplumbing.com/api-operation/) · [libvips affine docs](https://www.libvips.org/API/current/method.Image.affine.html) · [libvips affine.c](https://github.com/libvips/libvips/blob/master/libvips/resample/affine.c) · [sharp lib/index.d.ts](https://github.com/lovell/sharp/blob/v0.35.4/lib/index.d.ts)

**Saliency:** [smartcrop.js](https://github.com/jwagner/smartcrop.js) · [smartcrop-sharp](https://github.com/jwagner/smartcrop-sharp) · [imgproxy vips.c](https://github.com/imgproxy/imgproxy/blob/master/vips/vips.c) · [imgproxy url options](https://docs.imgproxy.net/generating_the_url_advanced) · [Thumbor](https://github.com/thumbor/thumbor) · [Thumbor transformer.py](https://github.com/thumbor/thumbor/blob/master/thumbor/transformer.py) · [Thumbor usage/meta](https://thumbor.readthedocs.io/en/latest/usage.html) · [GCV crop hints](https://cloud.google.com/vision/docs/detecting-crop-hints) · [GCV pricing](https://cloud.google.com/vision/pricing) · [Cloudinary automatic gravity](https://cloudinary.com/documentation/image_automatic_gravity) · [Cloudinary transformation reference](https://cloudinary.com/documentation/transformation_reference) · [imgix crop](https://docs.imgix.com/en-US/apis/rendering/size/crop) · [imgix focal point](https://docs.imgix.com/en-US/apis/rendering/focal-point-crop) · [OpenCV saliency module](https://github.com/opencv/opencv_contrib/tree/4.x/modules/saliency) · [U²-Net](https://github.com/xuebinqin/U-2-Net)

**Face detection:** [opencv_zoo YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) · [opencv_js.config.py](https://github.com/opencv/opencv/blob/4.x/platforms/js/opencv_js.config.py) · [OpenCV face.hpp](https://github.com/opencv/opencv/blob/4.x/modules/objdetect/include/opencv2/objdetect/face.hpp) · [@techstark/opencv-js](https://github.com/TechStark/opencv-js) · [libfacedetection.train](https://github.com/ShiqiYu/libfacedetection.train) · [@vladmandic/human](https://github.com/vladmandic/human) · [human Backends wiki](https://github.com/vladmandic/human/wiki/Backends) · [face-api.js](https://github.com/justadudewhohacks/face-api.js) · [@vladmandic/face-api](https://github.com/vladmandic/face-api) · [MediaPipe Face Detector](https://ai.google.dev/edge/mediapipe/solutions/vision/face_detector) · [MediaPipe Node issue #4800](https://github.com/google-ai-edge/mediapipe/issues/4800) · [onnxruntime install-metadata.js](https://github.com/microsoft/onnxruntime/blob/main/js/node/script/install-metadata.js) · [tfjs deps-constants.js](https://github.com/tensorflow/tfjs/blob/master/tfjs-node/scripts/deps-constants.js) · [nodejs/node#52744](https://github.com/nodejs/node/pull/52744) · [tensorflow/tfjs#8425](https://github.com/tensorflow/tfjs/pull/8425) · [OpenCV face_detect.cpp](https://github.com/opencv/opencv/blob/4.x/modules/objdetect/src/face_detect.cpp) · [OpenCV face.hpp](https://github.com/opencv/opencv/blob/4.x/modules/objdetect/include/opencv2/objdetect/face.hpp) · [OpenCV dnn.hpp blobFromImage](https://github.com/opencv/opencv/blob/4.x/modules/dnn/include/opencv2/dnn/dnn.hpp) · [opencv_zoo YuNet LICENSE](https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/LICENSE) · [onnxruntime install-metadata.js](https://github.com/microsoft/onnxruntime/blob/main/js/node/script/install-metadata.js) · [onnxruntime js/node README](https://github.com/microsoft/onnxruntime/blob/main/js/node/README.md) · [Node-API version matrix](https://nodejs.org/api/n-api.html) · [nodejs/docker-node versions.json](https://github.com/nodejs/docker-node/blob/main/versions.json)

**Face recognition:** [InsightFace README licence](https://github.com/deepinsight/insightface#license) · [InsightFace model zoo](https://github.com/deepinsight/insightface/blob/master/model_zoo/README.md) · [ONNX Model Zoo ArcFace](https://github.com/onnx/models/tree/main/validated/vision/body_analysis/arcface) · [EdgeFace](https://github.com/otroshi/edgeface) · [EdgeFace LICENSE](https://github.com/otroshi/edgeface/blob/main/LICENSE) · [EdgeFace arXiv:2307.01838](https://arxiv.org/abs/2307.01838) · [human match.ts](https://github.com/vladmandic/human/blob/main/src/face/match.ts) · [face-api FaceMatcher.ts](https://github.com/vladmandic/face-api/blob/master/src/globalApi/FaceMatcher.ts) · [dlib face recognition](http://dlib.net/face_recognition.py.html) · [AWS Rekognition collections](https://docs.aws.amazon.com/rekognition/latest/dg/collections.html) · [AWS Rekognition pricing](https://aws.amazon.com/rekognition/pricing/) · [AWS Rekognition endpoints](https://docs.aws.amazon.com/general/latest/gr/rekognition.html) · [Azure Face Limited Access](https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/computer-vision/limited-access-identity) · [GCV face detection](https://docs.cloud.google.com/vision/docs/detecting-faces) · [NIST FRVT masks](https://www.nist.gov/news-events/news/2020/07/nist-launches-studies-masks-effect-face-recognition-software) · [NISTIR 8280 demographics](https://nvlpubs.nist.gov/nistpubs/ir/2019/NIST.IR.8280.pdf) · [longitudinal child FR arXiv:2408.07225](https://arxiv.org/abs/2408.07225) · [edgeface LICENSE (BSD-3)](https://github.com/otroshi/edgeface/blob/main/LICENSE) · [idiap/EdgeFace-XS-GAMMA model card (CC BY-NC-SA 4.0)](https://huggingface.co/idiap/EdgeFace-XS-GAMMA) · [idiap/EdgeFace-S-GAMMA model card](https://huggingface.co/idiap/EdgeFace-S-GAMMA) · [InsightFace face_align.py (arcface_dst)](https://github.com/deepinsight/insightface/blob/master/python-package/insightface/utils/face_align.py) · [OpenCV face_recognize.cpp](https://github.com/opencv/opencv/blob/4.x/modules/objdetect/src/face_recognize.cpp)

**Legal:** [Swiss FADP SR 235.1, Fedlex](https://www.fedlex.admin.ch/eli/cc/2022/491/en) · [GDPR Art. 4](https://gdpr-info.eu/art-4-gdpr/) · [GDPR Art. 9](https://gdpr-info.eu/art-9-gdpr/) · [GDPR Art. 35](https://gdpr-info.eu/art-35-gdpr/) · [GDPR Art. 2](https://gdpr-info.eu/art-2-gdpr/) · [EU AI Act Art. 5, EC AI Act Service Desk](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-5)

**Object detection & pose:** [OWL-ViT arXiv:2205.06230](https://arxiv.org/abs/2205.06230) · [OWLv2 arXiv:2306.09683](https://arxiv.org/abs/2306.09683) · [google/owlvit-base-patch32](https://huggingface.co/google/owlvit-base-patch32) · [Transformers.js OWL-ViT model file](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/src/models/owlvit/modeling_owlvit.js) · [Transformers.js index](https://huggingface.co/docs/transformers.js/en/index) · [Grounding DINO](https://github.com/IDEA-Research/GroundingDINO) · [YOLO-World LICENSE](https://raw.githubusercontent.com/AILab-CVC/YOLO-World/master/LICENSE) · [Florence-2 doc](https://huggingface.co/docs/transformers/en/model_doc/florence2) · [T-Rex LICENSE](https://github.com/IDEA-Research/T-Rex/blob/main/LICENSE) · [Ultralytics LICENSE](https://raw.githubusercontent.com/ultralytics/ultralytics/main/LICENSE) · [ultralytics.com/license](https://www.ultralytics.com/license) · [D-FINE](https://github.com/Peterande/D-FINE) · [RF-DETR](https://github.com/roboflow/rf-detr) · [roboflow/inference LICENSE](https://raw.githubusercontent.com/roboflow/inference/main/LICENSE) · [Roboflow pricing](https://roboflow.com/pricing) · [tfjs-models pose-detection constants.ts](https://raw.githubusercontent.com/tensorflow/tfjs-models/master/pose-detection/src/constants.ts) · [MoveNet model card](https://raw.githubusercontent.com/tensorflow/tfhub.dev/master/assets/docs/google/models/movenet/singlepose/lightning/4.md) · [MMPose RTMPose](https://raw.githubusercontent.com/open-mmlab/mmpose/main/projects/rtmpose/README.md) · [CrowdHuman terms](http://www.crowdhuman.org/download.html) · [SCUT-HEAD](https://github.com/HCIILAB/SCUT-HEAD-Dataset-Release) · [MMPose LICENSE](https://github.com/open-mmlab/mmpose/blob/main/LICENSE) · [RTMPose project README](https://github.com/open-mmlab/mmpose/blob/main/projects/rtmpose/README.md) · [RTMPose arXiv:2303.07399](https://arxiv.org/abs/2303.07399) · [rtmlib](https://github.com/Tau-J/rtmlib) · [Xenova/movenet-singlepose-thunder](https://huggingface.co/Xenova/movenet-singlepose-thunder) · [tf2onnx](https://github.com/onnx/tensorflow-onnx) · [D-FINE export_onnx.py](https://github.com/Peterande/D-FINE/blob/master/tools/deployment/export_onnx.py) · [D-FINE postprocessor.py](https://github.com/Peterande/D-FINE/blob/master/src/zoo/dfine/postprocessor.py) · [onnx-community/dfine_n_coco-ONNX](https://huggingface.co/onnx-community/dfine_n_coco-ONNX) · [RF-DETR export docs](https://rfdetr.roboflow.com/latest/learn/export/) · [RF-DETR export/main.py](https://github.com/roboflow/rf-detr/blob/develop/src/rfdetr/export/main.py) · [ORT cpu_execution_provider.cc](https://github.com/microsoft/onnxruntime/blob/main/onnxruntime/core/providers/cpu/cpu_execution_provider.cc)

**Vision language models:** [Gemini image understanding](https://ai.google.dev/gemini-api/docs/image-understanding) · [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Claude coordinates and bounding boxes](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates) · [Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision) · [OpenAI images and vision](https://developers.openai.com/api/docs/guides/images-vision) · [PointArena arXiv:2505.09990](https://arxiv.org/html/2505.09990) · [UWBench arXiv:2510.18262](https://arxiv.org/pdf/2510.18262) · [LLM-Optic arXiv:2405.17104](https://arxiv.org/abs/2405.17104)

**Annotation & focal points:** [IPTC Photo Metadata Standard 2025.1](http://www.iptc.org/std/photometadata/specification/IPTC-PhotoMetadata-2025.1.html) · [IPTC user guide](https://www.iptc.org/std/photometadata/documentation/userguide/) · [IPTC image region examples](https://www.iptc.org/std/photometadata/examples/image-region-examples/) · [IPTC image region role CV](http://cv.iptc.org/newscodes/imageregionrole/) · [IPTC image region type CV](http://cv.iptc.org/newscodes/imageregiontype/) · [ExifTool XMP2.pl](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/XMP2.pl) · [ExifTool MWG.pm](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/MWG.pm) · [exiftool-vendored INSTALLATION.md](https://github.com/photostructure/exiftool-vendored.js/blob/main/docs/INSTALLATION.md) · [sharp api-output metadata](https://sharp.pixelplumbing.com/api-output/) · [Sanity image type](https://www.sanity.io/docs/image-type) · [@sanity/image-url urlForImage.ts](https://github.com/sanity-io/image-url/blob/main/src/urlForImage.ts) · [Payload uploads](https://payloadcms.com/docs/upload/overview) · [Payload createImageSizes.ts](https://github.com/payloadcms/payload/blob/main/packages/payload/src/uploads/image-resizing/createImageSizes.ts) · [Contentful Images API](https://www.contentful.com/developers/docs/references/images-api/) · [Storyblok focal point](https://www.storyblok.com/docs/api/image-service/operations/focal-point) · [Cloudinary custom focus areas](https://cloudinary.com/documentation/custom_focus_areas) · [darktable storage preferences](https://docs.darktable.org/usermanual/development/en/preferences-settings/storage/) · [IPTC social media metadata test](https://iptc.org/news/many-social-media-sites-still-remove-image-rights-information-from-photos/) · [react-image-crop](https://github.com/dominictobias/react-image-crop) · [WordPress FocalPointPicker](https://developer.wordpress.org/block-editor/reference-guides/components/focal-point-picker/)
