# Framing a Crop on a kart and its driver

*Research date: 5 Sep 2026. Two kinds of number appear below and they are always labelled. **Measured** means this study ran it against the deployed service at `https://meco-teal.vercel.app` and counted the answers. **Cited** means a primary source was read — model card, LICENSE file, official pricing page, paper — and the URL is at the bottom. A number with neither label does not appear.*

> **This is a point-in-time research snapshot, not the spec.** It answers the question [`docs/plans/faces-and-subject-aware-crop.md`](../plans/faces-and-subject-aware-crop.md) parked under "Later, not in this plan", and it assumes [`subject-aware-cropping.md`](./subject-aware-cropping.md) Q5 has been read. Domain terms are the ones defined in [`CONTEXT.md`](../../CONTEXT.md) — Source Image, Subject, Subject Box, Crop, Crop Anchor, Person, Face Print, Match, Face Blur — and are used exactly as defined.

---

## TL;DR

1. **A helmet is not a face, and meco already believes it is.** Measured on 32 on-track karting photographs: `POST /faces/detect` puts a box on the leading driver's head in **9 of 32 (28%)**, finds nothing at all in **19 of 32 (59%)**, and in **4 of 32 (13%)** returns a confident box on the *wrong* subject — a spectator in the crowd, or a distant driver while the foreground driver is missed. On 12 paddock and podium photographs with helmets off it is **12 of 12**. The face pipeline does not have a karting problem; it has a *visor* problem, and the paddock half already works.

2. **Person matching on a helmeted driver is not unreliable — it is actively wrong, and it is wrong today.** Measured: nine different drivers, nine helmets, 36 pairs. Median Face Print similarity **0.907**, minimum **0.639**. Twelve different people with helmets off: median **0.012**, maximum **0.388**. The same person photographed at two events, helmet off: **0.783**. `MATCH_THRESHOLD` is **0.50** (`src/people.ts:278`). **Every one of the 36 helmet pairs clears it, and 28 of 36 sit above the genuine same-person score.** EdgeFace collapses every full-face helmet onto approximately one identity. With a single Person enrolled there is no runner-up, so `MATCH_MARGIN` never fires and every helmeted stranger becomes a Match. This breaks `pinTo: "person"` and it breaks **Face Blur** — see [Q2](#q2--identity-the-measurement-that-decides-it), which is the one part of this document that is a bug report rather than a plan.

3. **EdgeFace is irrelevant to the racing case. Say it plainly.** There is no facial skin behind a closed visor, so there is nothing for a face recogniser to be right or wrong about. It stays relevant to the paddock, the podium and the team photograph, where it already works.

4. **The thing that ships this week needs no new model.** Measured: `pinTo: "attention"` — the saliency producer that is already merged — frames the kart and its driver well in **25 of 32**, acceptably in **29 of 32**, and loses the driver's head in **3 of 32**. That is not close to the face producer's 9 of 32. The change is one line of policy, not one line of ML: **stop letting a face outrank saliency when the "face" is a helmet.**

5. **The recommendation, when the 9% matters: a D-FINE-N kart detector feeding RTMPose-t — and [Q11](#q11--does-an-off-the-shelf-coco-detector-find-the-driver-with-no-fine-tuning) found the fine-tuning is not a prerequisite.** Measured: the *pretrained* COCO model yields a usable kart-and-driver box in **31 of 32** with no dataset at all, because `motorbike` resolves a kart and `person` resolves the driver. (Q11 first measured 21 of 32 against an export built from superseded weights; [Q12](#q12--what-licence-is-the-model-in-production-under-and-where-is-that-written-down) found the corrected checkpoint and the numbers moved with it.) That clears saliency's 25 — and the two still fail on **disjoint** photographs, so the answer remains a ladder rather than a replacement.

6. **Second choice: RF-DETR-Nano, and it lost on size, not on accuracy.** The premise that killed it in Q5 — "no pre-exported ONNX" — is now false. `onnx-community/rfdetr_nano-ONNX` exists and is properly tagged `apache-2.0`. But [Q11](#q11--does-an-off-the-shelf-coco-detector-find-the-driver-with-no-fine-tuning) measured the quantised D-FINE build as slower *and* less accurate than fp32, so the honest comparison is fp32 to fp32: **108.1 MB against 15.3 MB**, seven times the bytes for +5.7 COCO AP and an identical amount of TypeScript decode work. Cited. Take it only if a pilot shows 42.8 AP cannot find a kart.

7. **Reading the race number will not identify a driver, and the honest version of that sentence is uncomfortable.** The one published dataset with this exact geometry — professional photographers, numbers on a vehicle panel *and on the helmet*, motion blur, glare, occlusion — reports state-of-the-art scene-text spotters at **0.12–0.15 end-to-end F1 out of the box** and **0.527 after fine-tuning on 2,400 in-domain images**, with the authors writing that even the fine-tuned models "fall short of real-world viability". Cited. Do not put OCR in the crop path. If the number is wanted, buy it offline: **$16 per 100,000 photographs** on Gemini 2.5 Flash-Lite, cited, and design the consumer to accept "unknown" about half the time.

8. **Nothing in the recommendation is a rewrite.** `CROP_PRODUCERS` in `src/crop-solver.ts:33` is a `const` array and the solver reads `leader.producer` generically at line 500. A `kart` producer is one string in that array, one number in `PRIORITY` (`src/crop.ts:84`), and one branch in `subjectBoxes`. **`src/crop-solver.ts` needs no logic change at all** — ADR-0001's purity holds.

### The recommendation in one table

| | What | Added weight | When |
|---|---|---|---|
| **Now** | Saliency outranks a helmet: don't let the face producer lead when the detected "face" is not a face | **0** | This week |
| **Now** | Refuse to Match a face whose print is helmet-shaped — or gate Matching on the paddock case | **0** | Same change |
| **Next** | **Pretrained** D-FINE-N → `kart` Subject Box above saliency ([Q11](#q11--does-an-off-the-shelf-coco-detector-find-the-driver-with-no-fine-tuning)) | +15.3 MB (fp32; **not** q4f16) | No dataset needed |
| **Next** | RTMPose-t on the kart box → driver's head, eye line on the visor | +13.4 MB | With the above |
| **Not** | OCR of the race number in the crop path | +6.6 MB, 0.22 s | Never |
| **Maybe** | Race number read offline by a VLM, stored on the Annotation | 0 in the image | If someone asks for it |

---

## Q1 — Does the face producer see a helmeted driver?

This is the question everything else depends on, so it was measured rather than reasoned about.

### Method

44 photographs from Wikimedia Commons, drawn from `Category:Karting` and five sibling categories, then hand-classified into two sets by looking at each one:

- **On-track, helmeted** — 32 photographs, each with at least one driver in a kart wearing a full-face helmet, large enough in frame that a human names the driver's head without effort.
- **Paddock and podium, helmet off** — 12 photographs: prize-givings, team photographs, drivers standing beside karts.

Each was POSTed to `https://meco-teal.vercel.app/faces/detect` as `image/jpeg`, at the Commons 1600 px-long-side thumbnail. Every returned box was then rendered over the source and **looked at**, at 3.2× the box size, because a detection count is not a result — a box on a spectator counts as a detection and is worse than nothing.

Six of the 44 are committed under [`fixtures/karts/`](../../fixtures/karts/) with their provenance. Only the CC0 and public-domain ones; see that directory's `LICENCE.md` for why the bar is narrower than Commons'.

### Result — on track, helmeted (n = 32)

| Outcome | Count | Share |
|---|---|---|
| Box on the **leading driver's head** | **9** | 28% |
| Box on a driver's head, but a **background** one, while the foreground driver is missed | 2 | 6% |
| Boxes only on **spectators** behind the track | 2 | 6% |
| **Nothing** | 19 | 59% |

The 9 successes score **0.64–0.82**. The ten spectator faces in the worst false positive score **0.62–0.82**. There is no confidence band that separates a helmet from a face in the crowd behind it.

### Result — paddock and podium, helmets off (n = 12)

**12 of 12.** 39 faces in all, every box on a real face, scores **0.65–0.95**, including a nine-face team photograph and a thirteen-face one. Nothing here needs fixing.

### What the failures actually look like

The visor hypothesis is the obvious one and it is **wrong**. Detection does not track whether the visor is open:

- `on-track-visor-open.jpg` — clear visor, eyes visible, **0.81**. Detected, as expected.
- `on-track-rear-helmet.jpg` — driver facing **away**, box on the **back** of the helmet over the number panel, **0.65**. There is no face there in any sense, and YuNet is confident about it.
- Three separate photographs of white helmets with **dark closed visors** were detected at 0.76–0.80.
- `on-track-dark-visor.jpg` — two karts, two drivers, both large, sharp, well lit, visors down. **Zero faces.**

What YuNet is responding to is a helmet-shaped oval with a horizontal dark band across it, at the right scale. Sometimes that pattern is present and sometimes it is not, and nothing in the photograph predicts which.

### Would a tighter crop rescue it?

Worth testing, because it is exactly what a kart detector would provide. Each of the 19 zero-detection photographs was cut into a 3 × 3 grid of 50 %-size overlapping tiles — an effective 2× zoom — and all 171 tiles were run through `/detect`.

**Nine of 19 produced a detection. Four of those were the driver's head. Five were a tyre, a piece of bodywork, a blurred grandstand, and twice a kart's sidepod.**

So zooming in buys **+4 real heads and +5 confident false boxes**. That is not a rescue, and it is a specific warning about the recommended architecture: feeding a kart crop to YuNet does not turn YuNet into a head detector. The head model has to be a head model.

---

## Q2 — Identity: the measurement that decides it

If a face cannot be detected, it cannot be embedded, and Person matching cannot run. That much is obvious. The interesting question is what happens in the 28% of photographs where a helmet **is** detected — because there, meco does not fail. It succeeds, computes a Face Print of a helmet, and hands it to the matcher.

### Method

`POST /faces/embed` is stateless and stores nothing, so this needed no Person records and polluted no Brand. The largest detected box in each photograph was sent back with its landmarks, and the returned 512-float Face Print used directly.

- **H** — the 9 helmet detections that landed on a driver's head. Nine different drivers, nine different events, nine different helmets.
- **F** — 12 helmet-off faces. Eleven different people; two of the twelve are the same driver at two events (`podium-trophy.jpg` and `podium-trophy-2.jpg`).

Then every pairwise cosine.

### Result

| Comparison | Pairs | Min | Median | Max |
|---|---|---|---|---|
| **Helmet vs helmet**, nine different drivers | 36 | **0.639** | **0.907** | 0.967 |
| Face vs face, different people | 65 | −0.224 | 0.012 | 0.388 |
| Helmet vs face | 108 | −0.149 | −0.003 | 0.433 |
| **Same person**, helmet off, two events | 1 | — | **0.783** | — |

All measured.

### Read the first two rows against `MATCH_THRESHOLD = 0.50`

Different people with their faces showing sit at a median of 0.012 and never reach 0.39. That is the separation ADR-0003 calibrated on, and it is excellent — a threshold anywhere from 0.30 to 0.80 decides that set correctly.

Different *drivers in helmets* sit at a median of **0.907**. The worst-separated pair of strangers is 0.639. **Every single one of the 36 pairs clears 0.50.** Twenty-eight of the 36 score higher than the genuine same-person pair at 0.783.

To EdgeFace, all full-face helmets are one person.

### Why the margin does not save it

`MATCH_MARGIN = 0.05` requires the winner to beat the best *other* Person. ADR-0003 already records that the margin is "a guard at the size of run-to-run noise, chosen and not measured". Here it does nothing useful and in one configuration it does actual harm:

- **One Person enrolled** — the ordinary case for Swiss Hutless, where the Brand cares about one driver. There is no runner-up at all, so the margin is not consulted. Every helmeted stranger scores 0.64–0.97 against the enrolled Person and **is named as them**.
- **Two similar Persons enrolled** — both score ~0.9 against any helmet, the margin bites, and meco reports "unknown" for a photograph where it should have reported nothing in the first place. Right answer, wrong reason, and it will silently stop working when a Person is deleted.

### This is a live defect, not future work

Two merged behaviours are affected right now:

1. **`pinTo: "person"` (the default when a `brand` is given)** frames the Crop on whichever helmet EdgeFace happened to like. `resolvedBy` reports `"person"` and `matches` names a real Person. Nothing in the response says it is guessing.
2. **`blurUnknownFaces`** blurs "every detected face that is not a Match". In a karting photograph every detected helmet **is** a Match, so **nothing is blurred**. The option that exists to protect people who did not consent fails open, and fails open specifically on the brand that needs it.

`src/crop.ts:408-412` states the intent exactly right — *"who may be shown is not [a composition choice]"*. The intent is correct; the input is a helmet.

The cheapest correct fix is not a new model. Face Prints of helmets are not merely similar to each other, they are **orthogonal to real faces** — the helmet-vs-face median is −0.003 across 108 pairs. A helmet print is a recognisable object. Options, in ascending cost:

- Gate Matching on the Brand or the Placement — the paddock case matches, the on-track case does not.
- Keep one reference "helmet print" and refuse to Match any face whose similarity to it clears a threshold. Cheap, ugly, effective, and needs the fixture set that now exists to calibrate.
- Do not enrol on-track photographs, and do not Match them. A rule in `DEPLOY.md` with nothing enforcing it — weakest, but free.

Choosing between these is a decision for whoever owns ADR-0003. **This document's position is only that shipping the current behaviour to a karting brand is not acceptable, and that the number that proves it is 0.907 against a threshold of 0.50.**

---

## Q3 — Two cases, not one

The brief asked whether the on-track and paddock cases need different answers. They do, and the split is clean enough to be a design boundary rather than a caveat.

| | On track, helmeted | Paddock, podium, helmet off |
|---|---|---|
| Detection | 28% on the right head (measured) | 100% (measured) |
| Identity | **Impossible.** No facial skin; helmets collapse to one identity | Works. Same-person 0.783, strangers ≤ 0.388 (measured) |
| What the Crop should frame | The **kart and its driver together** — a head crop loses the brand | The face, with the existing eye-line rule |
| Right producer today | `saliency` | `face` / `person` |
| Right producer later | `kart`, with `face` demoted | Unchanged |
| Face Blur | Fails open — see Q2 | Works |

A photograph that is 90 % kart and 10 % helmet is a photograph *of a kart*. This came out of the comparison and was not anticipated: in several cases where the face producer *did* correctly find the helmet, the resulting Crop was **worse** than the saliency one, because the solver did what it is supposed to do and composed on the face — filling a 4:5 frame with a helmet and cutting the kart, the livery and the sponsor decals out of the picture. For a karting brand that is a loss even when the detection was right.

---

## Q4 — The thing that ships this week

Before any new model: the merged saliency producer was measured against the same 32 on-track photographs. Each was cropped through `POST /v1/crop` at 540 × 675 (4:5) with `pinTo: "attention"`, and every result was looked at.

| Outcome | Count | Share |
|---|---|---|
| Kart **and** driver's head well framed | **25** | 78% |
| Both present, composition mediocre — distracting foreground, subject small | 4 | 13% |
| **Driver's head cut off**, kart only | 3 | 9% |

Against the face producer's 9 of 32 on the same photographs, this is not a close contest. `sharp`'s attention heuristic likes the high-contrast, saturated, sharply-focused object in the frame, and on a race track that object is a kart.

The 3 failures are informative and they are all the same failure: saliency locks onto the kart's **bodywork** — the largest area of colour — and the frame stops below the helmet. That is precisely the gap a kart-plus-head producer fills, and it is why this section is a first step rather than the answer.

### The change

`src/crop.ts:352` currently reads: if `pinTo` is not `attention` and any face was detected, faces win outright. `pinTo` defaults to `person`. So a spurious helmet or crowd detection takes the frame away from saliency **before saliency is ever computed**.

The minimum honest fix is that a face may not lead unless it is a face. Three shapes, cheapest first:

1. **A `pinTo: "kart"` value** that behaves as `attention` does today. One string in `PIN_TO` (`src/crop.ts:37`), zero risk, and it makes the caller state the intent. It does not fix the default for a caller who does not know to set it.
2. **A per-Brand default** for `pinTo`. Swiss Hutless gets `attention`; laica and Hope Family keep `person`. Small, and it puts the karting knowledge where the karting brand is.
3. **Demote a face that is probably a helmet** using the Q2 finding — a print orthogonal to real faces and close to other helmets. Correct in general, needs calibration, and shares its machinery with the Face Blur fix.

Recommendation: **ship 2 now** — it fixes the default for the brand that has the problem, needs no calibration, and does not touch the solver — and treat 3 as part of the Q2 defect rather than part of this.

---

## Q5 — The recommendation, and the two Q5 facts that turned out to be wrong

The plan's proposal — **D-FINE-N to find the kart, RTMPose-t to find the driver's head inside it** — survives re-verification and remains the recommendation. Everything below was checked against primary sources today, and two of Q5's claims did not survive.

### D-FINE-N — sizes right, licence chain and postprocessing wrong

| Claim in Q5 | Verdict | What is actually true |
|---|---|---|
| `onnx-community/dfine_n_coco-ONNX` exists, 15,258,358 B fp32 / 5,966,346 B q4f16 | ✅ | Both byte counts confirmed exactly. Repo last modified 2025-04-30. Also ships int8 at 4,477,908 B |
| 4 M params, 42.8 COCO AP | ✅ | Upstream README, unchanged |
| Apache-2.0 | ⚠️ **Not on the artefact** | The ONNX repo's model card carries **no licence field and no licence tag**. Apache-2.0 is verifiable upstream (`Peterande/D-FINE` LICENSE, and the base model `ustc-community/dfine-nano-coco` declares `license: apache-2.0`) — but the card's `base_model` link points at `ustc-community/dfine_n_coco`, which **404s**. The licence chain on the exact file meco would ship runs through a broken link |
| Postprocessing is traced into the exported graph — `labels`/`boxes` xyxy absolute/`scores` sigmoided, top-300, no NMS | ❌ **False** | The graph was loaded and read. `INPUT: pixel_values [batch,3,h,w]` — one input, **no `orig_target_sizes`**. `OUTPUT: logits [batch,300,80]`, `pred_boxes [batch,300,4]`. Scores are **raw logits**. Boxes are **cxcywh, normalised 0..1**. `300` is the fixed decoder query count, not a top-k selection. The "no NMS" half is correct |

The behaviour Q5 described **does exist** — it is what `tools/deployment/export_onnx.py` produces upstream, wrapping `cfg.postprocessor.deploy()`. It is simply not what Hugging Face ships. So there is a fork:

- **Use the HF export** and write sigmoid, cxcywh→xyxy, scale-to-image and top-k in TypeScript. Perhaps 40 lines. Free of a Python step.
- **Run the upstream export yourself** and get `labels`/`boxes`/`scores` in the graph. This is the repo's existing bar — `packages/faces/scripts/export-edgeface.py` pins an upstream commit SHA and the export is verified against the source model. Doing the same for D-FINE means a second Python script, a second pinned SHA, and a second verification.

**Recommendation: use the HF export and write the decode.** Fine-tuning already requires a Python step and a checked-in `.onnx`, so the export script exists either way — but the *pre-export* is a byte-identical artefact anyone can re-download and diff, and 40 lines of arithmetic in TypeScript is easier to test than a Python graph surgery. Note the preprocessing while you are there: `preprocessor_config.json` says `size: 640×640`, `do_rescale: true` (1/255), and **`do_normalize: false`** — no ImageNet mean/std, which contradicts what a reader would assume from every other model in this repo.

Two constraints from Q5 stand and must be repeated because getting them wrong is silent: stay on **`dfine_n_coco`** (the only D-FINE size with no Objects365 lineage) and **train from COCO weights, not the recommended Objects365 ones**.

### RTMPose-t — correct in every particular

Every claim verified, including both byte counts to the byte:

| | |
|---|---|
| SDK zip | 12,547,710 B — live `HEAD` returns 200, `Last-Modified` 31 Aug 2023 |
| `end2end.onnx` inside | **13,350,364 B** |
| Licence | Apache-2.0, `open-mmlab/mmpose` LICENSE |
| Graph | opset 11, `input [batch,3,256,192]`, `simcc_x [batch,K,384]`, `simcc_y [batch,K,512]`. SimCC decode is **not** in the graph |
| Preprocessing | `TopDownGetBboxCenterScale(padding=1.25)` → `TopDownAffine([192,256])` → **ImageNet mean/std** — the opposite of D-FINE-N |
| COCO AP, body7 | **t 65.9**, s 69.7 |
| Still linked | Yes — line 212 of MMPose `main`'s `projects/rtmpose/README.md` |

**One new fact, and it is a risk rather than a blocker: MMPose and MMDeploy are dormant.** Neither is archived, but MMPose's last push was 4 Aug 2025 and MMDeploy's was 30 Sep 2024. For a pinned `.onnx` downloaded once and committed, a frozen upstream is close to harmless — the artefact does not rot. It does mean nobody will fix a bug in it, and it should be written into whatever ADR accepts this.

Q5's empirical finding — that RTMPose-t holds 0.29–0.55 confidence on helmet keypoints where MoveNet Thunder collapses to 0.05–0.17 — was **not** re-measured by this study and remains a three-photograph sample. It is still the reason to prefer RTMPose-t and it is still thin. The fixture set now committed under `fixtures/karts/` is where a wider check should run.

### Why this pairing and not something else

The alternative to two models is one model that does both. None qualifies:

- Open-vocabulary detection was ruled out in Q5 on size (127–151 MB) and that has not changed.
- A head detector would be simpler than pose — but Q5 established that every dedicated head detector traces back to CrowdHuman or SCUT-HEAD, both non-commercial, and **no racing or kart helmet detector exists on Hugging Face**. Re-checked: still true.
- Q1's tiling experiment settles the tempting shortcut: **YuNet on a kart crop is not a head detector.** Four true heads and five confident false boxes.

---

## Q6 — Second choice, and why it lost

**RF-DETR-Nano.** Q5 rejected it partly on a premise that has since become false, so it deserves a fair re-hearing.

| | D-FINE-N | RF-DETR-Nano |
|---|---|---|
| Licence | Apache-2.0 upstream; **not declared on the ONNX repo** | Apache-2.0, **declared in the ONNX repo's cardData and tags** |
| Pre-exported ONNX | Yes | **Yes** — `onnx-community/rfdetr_nano-ONNX`, which Q5 said did not exist |
| fp32 | **15,258,358 B** | 108,074,865 B |
| q4f16 | **5,966,346 B** | 18,996,625 B |
| Params | 4 M | 30.5 M |
| Input | 640 × 640 | 384 × 384 |
| COCO AP | 42.8 | **48.4** |
| Graph output | `logits` + `pred_boxes`, 80 classes, undecoded | `logits` + `pred_boxes`, **91** classes, undecoded |

All cited.

**It loses on size, and by more than this table first suggested.** Q11 measured D-FINE's q4f16 build as 2.3× slower than fp32 and worse at finding a kart, which makes the q4f16 row a comparison of two builds neither model should ship. fp32 to fp32 it is **108,074,865 B against 15,258,358 B** — seven times the bytes for +5.7 AP, on a container that scales to zero and pays its cold start on a real request. And the one advantage Q5 imagined for D-FINE — a decoded graph — turns out not to exist, so RF-DETR's "raw tensors" objection no longer distinguishes them: **both hand back undecoded `logits` and `pred_boxes` and both need the same TypeScript**. The shape-ambiguity trap Q5 warned about is real and is now the only differentiator, and it is a code-review problem, not an architecture one.

It is a genuinely safe fallback. Take it if a pilot shows 42.8 AP cannot reliably find a kart — and note it declares its licence on the artefact, which D-FINE-N does not.

### One thing worth watching, not recommending

**DETRPose-N** — Apache-2.0, 4.1 M params, **bottom-up multi-person pose in a single forward pass**, 16,677,992 B as safetensors. It would collapse detect → crop → pose into one model and delete the whole affine-crop stage. But **no ONNX is published**, so it needs a self-export against this repo's bar, and its 57.2 AP is an end-to-end multi-person number that is not comparable to RTMPose-t's 65.9 single-person figure. Interesting; not yet a candidate.

Two models were checked and **disqualified on licence**, both of which would otherwise have won:

- **DEIMv2-N** — 43.0 AP at 3.6 M params, better than D-FINE-N on both axes. Its `LICENSE.md` reads *"No rights are granted for Commercial Use"* and names SaaS and APIs explicitly. Covers the weights. Dead.
- **YOLO26 / YOLO26-pose** — pre-exported ONNX exists and is popular. Upstream weights are AGPL-3.0. Dead, as every YOLO before it.

---

## Q7 — Identity without a face

If EdgeFace cannot name a helmeted driver, what can? Three candidates, costed.

### Race number — the obvious answer, and it does not work

Karts carry a number panel front and rear, and numbers often appear on the helmet. Reading it is a scene-text problem, and there is one published dataset with almost exactly this geometry: **RnD**, 2,411 photographs from 16 professional motorsports photographers at 50 off-road motorcycle events, numbers on the bike plate, the wheels, and *the cheeks of the racer's helmet*. Cited.

Its results are the whole answer:

| | Detection F1 | **End-to-end F1** |
|---|---|---|
| SwinTextSpotter, off the shelf | 0.232 | **0.120** |
| YAMTS, off the shelf | 0.276 | **0.148** |
| SwinTextSpotter, fine-tuned on 2,411 images | 0.734 | 0.459 |
| YAMTS, fine-tuned | 0.775 | **0.527** |

And per condition, fine-tuned: motion blur 0.529 end-to-end, glare **0.289**. Detection stays high while recognition collapses — the dominant failure is "found the panel, cannot resolve the digits". The paper's own qualitative note is that occlusion *"often prevents smaller helmet numbers from being recognized"*. The authors' conclusion: *"even fine-tuned models fall short of real-world viability."* All cited.

The reassuring 87–93 % figures from football jersey-number work do not transfer: those are **tracklet-level**, won by majority-voting an average of 482 frames per player and discarding the illegible ones. A photograph is one frame. There is no vote.

**And there is nothing to download.** Every pretrained bib- or jersey-number model found is CC BY-NC (`mkoshkina/jersey-number-pipeline`, `lukaszgrad/uncertainty-jnr` — whose README badge claims CC-BY-SA while its LICENSE says NonCommercial) or an AGPL-tainted YOLO fine-tune. The datasets are worse: SoccerNet is GPL-3.0/AGPL-3.0, RBNR carries no licence at all, RnD's repo reports `license: None`, and **SVHN — the digit corpus almost every digit model is pre-trained on — states "for non-commercial use only" on its official page**. That last one is a landmine: it taints models that look permissive. All cited.

The clean stack exists — **PP-OCRv6-tiny, Apache-2.0, first-party ONNX, 1,780,590 B detection + 4,462,639 B recognition = 6.6 MB, 0.22 s per image on ORT CPU**, cited — but it is a body to fine-tune on kart photographs you label yourself, not a solution. Planning figure, extrapolated and labelled as such: **50–60 % correct full-number reads after fine-tuning; 10–20 % off the shelf.**

**Verdict: never in the crop path.** 0.22 s per image on a scale-to-zero container to be wrong half the time is the worst trade in this document.

### Race number read offline by a vision model — the one that is actually worth doing

The number only has to be read **once per Source Image**, and meco already has the place to put it: the Annotation, keyed by content hash, computed on a miss and reused by every Crop. That turns a per-request cost into a one-off.

| | Input tokens, 1920 × 1080 | Per 100,000 photographs |
|---|---|---|
| Claude Haiku 4.5 | 1,560 | $166.00 ($83 batched) |
| Gemini 2.5 Flash-Lite | 1,548 | **$16.28** ($8.14 batched) |

Cited, from the official pricing and vision pages. Sixteen dollars to read a hundred thousand race photographs is less than the engineering hours to export one ONNX file, adds nothing to the image, and sidesteps the entire licence minefield above.

Two caveats, both real: **no published accuracy exists for a VLM on racing numbers** — RnD predates them and did not test one, so this must be piloted — and Q5's standing rule holds, that a vision model may **label**, never **frame**.

### Helmet livery — not researched, and probably the best long-term answer

A driver's helmet design is stable across a season and often across a career, high-contrast, and always in frame when the driver is. Matching it is an image-retrieval problem, not a recognition problem: embed the helmet crop, compare to a small per-Brand gallery, exactly the shape `src/people.ts` already implements for faces.

Q2's data is quietly encouraging here. The 36 helmet-vs-helmet pairs range 0.639–0.967 — a **0.33 spread** — which means EdgeFace's helmet prints are not constant. Something in them varies with the helmet. Whether that something is livery or lighting is **not determined** and would need the obvious experiment: two photographs of the same driver in the same helmet at different events. This study did not have such a pair, which is why this is a lead and not a recommendation.

If it works it is nearly free: no new model, an existing embedder, and a gallery mechanism already written. If it does not, the fallback is a small dedicated embedder and that is a much bigger conversation.

---

## Q8 — How it plugs in

The plan requires that this be an addition. It is. Every claim below was read from the current `main` at `8b7ee1f`.

**`src/crop-solver.ts` needs no logic change.** `CROP_PRODUCERS` at line 33 is `["person", "face", "saliency", "anchor", "centre"]`, `CropProducer` is derived from it at line 35, and the solver takes the winner generically — `resolvedBy: leader.producer` at line 500. Adding `"kart"` to that array is a type-level change that the solver's arithmetic never sees. It remains pure, and ADR-0001 holds untouched.

The additions, in full:

| File | Change |
|---|---|
| `src/crop-solver.ts:33` | `"kart"` in `CROP_PRODUCERS`. No other change |
| `src/crop.ts:84` | `kart: 45` in `PRIORITY` — above `face` (40), below `person` (50). A named Person still wins; a helmet no longer does |
| `src/crop.ts:37` | `"kart"` in `PIN_TO` |
| `src/crop.ts:329` | One branch in `subjectBoxes`, ahead of the face branch |
| `src/faces.ts` | A `detectKart()` client beside `detect` and `embed` |
| `packages/faces` | `POST /kart` — kart box plus head point, same bearer check, same statelessness |
| `src/api.ts:294` | `resolvedBy` gains a value. **A public API change** — the only one |

The Subject Box the producer yields:

```ts
{ x, y, width, height,          // the kart, fractions of the Source Image
  producer: "kart", priority: 45, keep: true,
  eyeY }                        // the driver's head from RTMPose-t
```

`eyeY` is the existing seam and it is exactly right here. `SubjectBox` already carries it, the solver already puts it on the upper phi line, and RTMPose-t's nose/eye/ear keypoints land on the **visor** — which is where a viewer's eye goes on a helmeted driver anyway. Q5's weighted head centre applies unchanged:

```
headCentre = Σ(score_i · p_i) / Σ(score_i)   over {nose, left_eye, right_eye, left_ear, right_ear}
```

The box is the **kart**, not the head. That is the point of Q3: a Crop that frames the head loses the brand.

---

## Q9 — What it costs to carry

The faces image today, from `DEPLOY.md`:

| | |
|---|---|
| Image, `linux/amd64` | 377 MB on disk, 234 MB of it the `node:24-slim` base; **129 MB in the registry** |
| Models | YuNet 229,738 B + EdgeFace 7,277,244 B |
| Cold, 12 MP | ~470 ms `docker run` to served detection |
| Warm detect, 12 MP | ~38 ms median |

The delta this adds:

| Option | On disk | Cold-start cost |
|---|---|---|
| **D-FINE-N fp32 + RTMPose-t** ← recommended | **+28.6 MB** | Two more ORT sessions. D-FINE's own session create measured at **167 ms** (Q11); the pair is still unmeasured |
| D-FINE-N fp32 alone, no pose | +15.3 MB | 167 ms session create, 28 ms warm — both measured |
| D-FINE-N q4f16 + RTMPose-t | +19.4 MB | **Rejected** — Q11 measured q4f16 at 2.3× the inference time of fp32 and worse accuracy |
| RF-DETR-Nano fp32 + RTMPose-t | +121.4 MB | as above |
| PP-OCRv6-tiny, both stages | +6.6 MB | +0.22 s **per request**, not per boot |

On a 129 MB registry image the recommended pair is roughly **+15 %**, and most of that is RTMPose-t rather than the detector.

**Cold start is the number that is not known and it is the one that matters.** DEPLOY.md's ~470 ms is for two models; nobody has measured four. The plan already sets the budget (< 1.5 s cold) and the mechanism (module-scope sessions, reused by Fluid Compute). Measuring it is a verification gate, not a research question — but it is the gate most likely to fail, and quantisation choice should be made against it rather than against the size table above.

One genuine saving is available and should be taken: **the kart path does not need EdgeFace.** If the two producers are split across endpoints, an on-track Crop can avoid loading a 7 MB model it has no use for.

---

## Q10 — Staged plan

### Stage 0 — this week, no new model

1. Per-Brand default `pinTo`. Swiss Hutless → `attention`. Measured effect: **25 of 32 well framed instead of 9 of 32.**
2. Decide the Q2 defect. `blurUnknownFaces` failing open on a karting photograph is the part that cannot wait for a model.
3. Add `fixtures/karts/` to whatever test names the crop producers, using the numbers in Q1 as the assertion.

Ships in a day. Fixes the visible problem for the brand that has it.

### Stage 1 — the kart producer

4. Label karts. 100–500 photographs; Q5's rule that a vision model may label but not frame applies, and Q7's $16-per-100k makes the labelling pass nearly free. **No primary source states a minimum dataset size** — Q5 flagged this and it is still unverified. Assume a rented GPU hour.
5. Fine-tune `dfine_n_coco` from COCO weights. Commit the `.onnx` with its export script and a pinned upstream SHA, as `export-edgeface.py` does.
6. `POST /kart` in `packages/faces`, ~40 lines of decode: sigmoid, cxcywh→xyxy, scale to image, top-k. Stretch resize to 640, rescale to [0,1], **no** ImageNet normalisation.
7. `kart` producer in `subjectBoxes` at priority 45, box only, no `eyeY` yet. Verification: the 3 photographs where saliency loses the head now keep it.

### Stage 2 — the driver's head

8. RTMPose-t on the kart box, padded to include the torso — never a tight head crop. ImageNet normalisation **does** apply here. SimCC argmax decode, `use_dark: false`, `flip_test: false`, ~60 lines.
9. `eyeY` from the weighted head centre. Verification: the eye line lands on the visor within ±2 % at 1:1, 4:5, 9:16 and 16:9.
10. Measure cold start with four models. Choose quantisation against that number.

### Stage 3 — only if someone asks

11. Race number, offline, VLM, stored on the Annotation. Design the consumer for "unknown" about half the time.
12. Helmet livery matching, if the Q7 experiment says the print varies with the helmet rather than the light.

### What to do first, in one sentence

**Do stage 0 and stop**, until someone has a Swiss Hutless photograph that stage 0 gets visibly wrong — because 25 of 32 with no new bytes is a better place to be arguing from than 9 of 32.

---

## Q11 — Does an off-the-shelf COCO detector find the driver, with no fine-tuning?

*Added 5 Sep 2026, after the rest of this document. It asks whether the fine-tuning in [Q10](#q10--staged-plan) stage 1 is actually a prerequisite. **It is not**, and the reason is not the class anybody expected.*

> **Read [Q12](#q12--what-licence-is-the-model-in-production-under-and-where-is-that-written-down) alongside this section.** Every number below was measured against `onnx-community/dfine_n_coco-ONNX`, which was exported on 2025-04-30 — before its base checkpoint was corrected by a commit titled `Fix weights` on 2025-08-20. On the fixed weights the same code, the same photographs and the same thresholds give **29 of 32 rather than 21**, and **31 of 32** once the largest-box rule this section left untested is applied. The findings below all hold in shape; the rates are the floor, not the result.

Q5 and Q10 both assume a **fine-tuned** kart detector, which means a labelled dataset, which is a project rather than a week. But the thing that has to be framed is a *driver*, and `person` is a COCO class that every pretrained detector ships with. So the assumption was tested rather than carried.

### Method

**D-FINE-N**, `onnx-community/dfine_n_coco-ONNX`, `onnx/model.onnx`, **fp32, 15,258,358 B** — the byte count re-confirmed by downloading it. `onnxruntime-node@1.29.0`, CPU, Apple M4, the same 32 on-track photographs as Q1 and Q4, so every number here is directly comparable.

The decode was written to [Q5's correction](#q5--the-recommendation-and-the-two-q5-facts-that-turned-out-to-be-wrong), and writing it confirmed that correction in every particular: one input `pixel_values`, outputs `logits [1,300,80]` **raw** and `pred_boxes [1,300,4]` **cxcywh normalised**, no `orig_target_sizes`, **no NMS**. Stretch-resize to 640 × 640, rescale 1/255, **no** ImageNet normalisation, per `preprocessor_config.json`. Sigmoid and a max over the 80 classes per query, threshold 0.28, then **NMS at IoU 0.6 written by hand** — with 300 queries and no suppression in the graph, near-duplicates are the norm and an un-suppressed count is meaningless.

Every box was rendered over its photograph and looked at, as in Q1.

### Result 1 — `person` alone

| Outcome | Count | Share |
|---|---|---|
| `person` box on the **leading driver** | **20** | 63% |
| `person` boxes only on **spectators or marshals** | 5 | 16% |
| No `person` at all | 7 | 22% |

Against the face producer's 9 of 32, that is more than double. Against saliency's 25 of 32, it is worse.

And the 5 failures are the **same failures**, on the same photographs. On the two crowd-heavy shots where YuNet found only spectators, D-FINE finds 23 and 13 spectators and misses the driver entirely. A detector trained on COCO is very good at people standing behind a fence, and a person folded into a kart seat at speed is not what "person" looks like in COCO.

### Result 2 — `motorbike` is the class that works

This was not the hypothesis, and it is the finding.

| Class | Fires on the right object | Share |
|---|---|---|
| `motorbike` → **the kart** | **21 / 32** | 66% |
| `person` → the driver | 20 / 32 | 63% |
| **Neither, nothing at all** | 3 / 32 | 9% |

COCO has no kart class, so a kart is resolved to the nearest thing in the vocabulary — and `motorbike` is a remarkably good nearest thing: an open-wheeled, seated vehicle with a rider on it. The boxes are tight on the kart, not on the grandstand. The confusions when it misses are `boat`, `car` and `train`, which are all *also* roughly the right region and the wrong word.

### Result 3 — the combined box, which is what a producer would actually yield

The natural rule needs no model at all: **take the highest-scoring `motorbike` box, add every `person` box that overlaps it by more than 25 % of the smaller box, and union them.** That is "the kart and whoever is on it", and it fixes the crowd problem for free — a spectator does not overlap the kart.

| Outcome | Count | Share |
|---|---|---|
| Union box **usable to frame on** — the leading kart, its driver, tight | **21** | 66% |
| Right subject, but the driver's head is clipped above the box, or the subject is distant | 4 | 13% |
| **Wrong subject or nothing** | 7 | 22% |

Box tightness, measured: median area **24.4 % of the frame**, range 0.1 %–80.4 %. Three of 29 exceed 60 %; the four under 2 % are exactly the spectator-and-marshal failures. **A grandstand box never happened.** This is question 2 answered: the box is a Subject Box, not a region proposal.

### Result 4 — is `person` enough on its own?

No, and the margin is not small.

- `motorbike` **rescues 6 photographs** where `person` found nothing (4) or only the crowd (2). Four of those are photographs where YuNet also found nothing — genuinely new coverage.
- `motorbike` **hurts twice**, both the same way: the highest-scoring kart is a *distant* one, so the union walks away from the foreground subject. A largest-box rule instead of a highest-score rule would probably fix both, and was not tested.

Adding `bicycle` changed nothing on this set. Do not add `car`, `boat` or `train`: they fire on the kart *and* on trackside vehicles, and the precision is not worth it.

### Result 5 — size and speed, measured

| | fp32 | q4f16 |
|---|---|---|
| Bytes | **15,258,358** | 5,966,346 |
| Session create | **167 ms** | 223 ms |
| First inference | 35 ms | 41 ms |
| **Warm median, 20 runs** | **28 ms** | **64 ms** |
| `motorbike` present, of 32 | **21** | 17 |
| `person` present, of 32 | **25** | 23 |

**Do not ship the quantised build.** It is 2.3× *slower* and less accurate — it loses four kart detections and two driver detections out of 32, and it drops two photographs the fp32 build handles, including the helmet portrait. This is the same trap Q5 recorded for MoveNet, where the int8 build measured 31.83 ms against 14.41 ms for fp32, and it should now be treated as the default expectation for this runtime rather than a surprise.

So the honest budget is **+15,258,358 B and ~28 ms**, not the +6.0 MB the TL;DR table quoted. Note also that `sharp` decode and resize of a 1920 × 1440 JPEG measured **31 ms** — more than the inference. The model is not the cost.

### The verdict, and it is not "replace saliency"

A pretrained detector is **worse than saliency** on this set: 21 usable boxes against 25. That could end the section. It should not, because **the two fail on disjoint photographs**:

| | Saliency | Pretrained detector |
|---|---|---|
| Usable | 25 | 21 |
| Fails hard | **3** — the driver's head is cut off, the kart's bodywork won the frame | **7** — a spectator, a marshal, a distant kart, or nothing |
| Photographs where **both** fail hard | **0** | |

The detector fixes **two of saliency's three failures** outright: on both, saliency framed the bodywork and lost the helmet, and a `person` box lands squarely on the driver. And saliency handles **all seven** of the detector's failures, because a crowd is not salient and a kart is.

**So the shape of the feature is a fallback ladder, which is what `subjectBoxes` already is.** The detector does not replace the saliency producer; it sits above it and yields when it has nothing:

```
kart (person ∪ motorbike, pretrained)  →  saliency  →  anchor  →  centre
```

This is strictly additive, needs no dataset, no labelling pass and no GPU hour, and it plugs in exactly as [Q8](#q8--how-it-plugs-in) describes.

### What this does to the staged plan

[Q10](#q10--staged-plan) stage 1 said "label karts, fine-tune, then build the producer". That ordering is now wrong. Replace it with:

1. **Ship the pretrained producer first.** `POST /kart` runs D-FINE-N fp32, returns the union box. Roughly 60 lines of decode plus the NMS, all of it already written once for this study.
2. **Then decide whether fine-tuning is worth it**, against a real number rather than an assumption.

Fine-tuning still buys three specific things, and they are now improvements rather than prerequisites: the 3 photographs where the detector sees nothing at all, the wrong-kart selection in a pack, and the `boat`/`car`/`train` confusions. Whether that is worth a labelled dataset is a decision the owner can now make against **21 of 32**, which is the point of measuring it.

### The fixtures reproduce it

Run against the six committed photographs in `fixtures/karts/`, D-FINE-N fp32 at threshold 0.28:

| Fixture | What it finds | Against YuNet |
|---|---|---|
| `on-track-dark-visor.jpg` | **`person` 0.34 and 0.30, on both drivers** | YuNet: **zero faces** |
| `on-track-rear-helmet.jpg` | `person` 0.43 on the driver, `motorbike` 0.28 on the kart | YuNet: one box, on the back of the helmet |
| `on-track-visor-open.jpg` | `motorbike` 0.35 on the kart, **no `person`** | YuNet: 0.81 on the visor |
| `paddock-mixed.jpg` | 8 × `person`, `motorbike` 0.37 | YuNet: 9 faces |
| `podium-trophy.jpg` | `person` 0.48 | YuNet: 0.92 |
| `podium-trophy-2.jpg` | `person` 0.32 | YuNet: 0.92 |

The first row is the whole argument in one line. **The photograph the face detector cannot see at all is a photograph where a pretrained COCO detector puts a box on each driver** — and the third row is the honest counterweight: a large, sharp, unmissable driver that `person` does not find, while `motorbike` finds the kart underneath them. Neither model is reliable alone. Together with saliency, they cover the set.

---

## Q12 — What licence is the model in production under, and where is that written down?

*Added 5 Sep 2026, as the gate on the kart producer build. [Q11](#q11--does-an-off-the-shelf-coco-detector-find-the-driver-with-no-fine-tuning) recorded that the ONNX model card declares no licence. This resolves that, and in doing so found that **the artefact Q11 measured is built from superseded weights** — so the answer changes the numbers as well as the paperwork.*

**The one-sentence answer: D-FINE-N is Apache-2.0, and the artefact to ship is [`AnnotateIt/dfine-nano-coco-onnx`](https://huggingface.co/AnnotateIt/dfine-nano-coco-onnx), which declares `license: apache-2.0` on the model itself and ships the Apache-2.0 text as a `LICENSE` file — unlike `onnx-community/dfine_n_coco-ONNX`, which declares nothing.**

### The chain, link by link

| Link | What it is | Licence | Where that is written |
|---|---|---|---|
| 1. Training code | `Peterande/D-FINE` | **Apache-2.0** | `LICENSE` — read directly, 169 lines, the verbatim Apache License 2.0 text, no added clause |
| 2. Released checkpoint | `dfine_n_coco.pth` | Apache-2.0 by the repo that released it | Linked from the D-FINE README model zoo, hosted on `Peterande/storage` releases |
| 3. HF weights | `ustc-community/dfine-nano-coco` | **Apache-2.0, declared** | `license: apache-2.0` in the card's YAML **and** as the HF tag `license:apache-2.0` |
| 4a. ONNX as measured in Q11 | `onnx-community/dfine_n_coco-ONNX` | **none declared** | no `license` in cardData, no `license:*` tag, no `LICENSE` file |
| 4b. ONNX recommended | `AnnotateIt/dfine-nano-coco-onnx` | **Apache-2.0, declared** | `license: apache-2.0` in cardData **and** tag, **plus** an 11,357-byte `LICENSE` file carrying the full Apache-2.0 text |

**Link 3 is the one that matters, and it is clean.** The weights repo declares Apache-2.0 itself rather than inheriting it. Its commit history shows where the weights came from: `Add model from convert_d_fine_original_pytorch_checkpoint_to_hf.py` (28 Mar 2025) — a **format conversion of Peterande's released checkpoint**, not an independent retrain. So the grant does not have to travel from the code to the weights by implication; the party that published the weights stated it.

That distinction matters more than it looks. See [below](#do-weights-inherit-the-code-licence).

### Who published the ONNX, and why its card is blank

`onnx-community` is the Transformers.js export effort — the org avatar resolves to the user id of Xenova (Joshua Lochner), and nearly every export carries `library_name: transformers.js`. It has **425 members, `isVerified: false`, and no organisation card at all** (`onnx-community/README` returns 401). There is **no organisation-level licence statement**, verified negative.

The conversion tool is the [`convert-to-onnx`](https://huggingface.co/spaces/onnx-community/convert-to-onnx) Space. Its README declares `license: apache-2.0` — **that is the licence of the converter, not of anything it produces** — and says nothing about propagating a source repo's licence into the generated card. Which is exactly why `dfine_n_coco-ONNX`'s cardData is only `{library_name, base_model}`: the bot writes those two fields and stops.

A further sign that the card is unmaintained rather than deliberate: its `base_model` names `ustc-community/dfine_n_coco` with underscores, which **404s**. HF's own tags resolve the correct hyphenated repo, so the machine-readable provenance is right and the human-readable link is broken.

Hugging Face documents **no default licence** for a repo that declares none. Their licence docs say only that you *"are able to add a license… to let other users know about the permissions that you want to attribute"*, and their own taxonomy includes an opt-in `unknown` value that nobody selected here. The HF Terms of Service do grant each user a licence over public repo content, but scoped *"through our Services and functionalities"* — a platform grant, not a basis for redistributing weights inside a commercial product. **An untagged repo is a licence gap, not a licence grant**, and that is the whole problem with 4a.

### Is COCO a problem?

**No — and this is the question that was worth asking, because the repo has been burned by exactly this before.** [Q7](#q7--identity-without-a-face) records SVHN's *"for non-commercial use only"* quietly tainting digit models. COCO is not that.

From COCO's terms of use:

> **Annotations & Website.** The annotations in this dataset along with this website belong to the COCO Consortium and are licensed under a **Creative Commons Attribution 4.0 License**.
>
> **Images.** The COCO Consortium does not own the copyright of the images. Use of the images must abide by the Flickr Terms of Use.

So: annotations **CC BY 4.0**, attribution only, **no non-commercial clause anywhere in COCO's terms**. The images are disclaimed rather than restricted.

Contrast Objects365, which is the genuine hazard:

> The Objects365 dataset is available for the **academic purpose only**. … **You will NOT distribute the above images.**

That is an explicit whole-dataset commercial gate, and **D-FINE's own README says so** at line 137: *"Checkpoints trained or pretrained on Objects365 (`*_obj365`, `*_obj2coco`) may be subject to the Objects365 dataset terms and should not be assumed to be commercially cleared under the D-FINE license."*

`dfine_n_coco` is COCO-only and sits outside that carve-out — and the carve-out is itself useful evidence, because a maintainer who names the checkpoints that are *not* cleared is telling you the others are. Q5's rule stands: **stay on `dfine_n_coco`, never an `_obj365` or `_obj2coco` variant.** The same rule rules out `PekingU/rtdetr_*_coco_o365`.

**The one residual, stated so it is not a surprise later:** COCO's annotation JSON carries eight per-image Flickr licences and three of them are NonCommercial (`by-nc-sa/2.0`, `by-nc/2.0`, `by-nc-nd/2.0`). Whether a per-image NC licence flows through to a *trained model* — as opposed to redistributing the pixels — is unresolved by COCO's terms and by anything else found. It is diffuse, industry-wide, and applies equally to **every** COCO-pretrained detector, so it does not distinguish between any of the candidates in [Q6](#q6--second-choice-and-why-it-lost) or here. It is not a reason to choose differently; it is a reason to know.

### Do weights inherit the code licence?

Not automatically, and anyone who says otherwise is guessing. What was actually found:

- **The Apache Software Foundation is silent.** Their licence FAQ and legal pages contain no mention of machine learning, model weights, or trained models. Verified negative.
- **OSI treats parameters as separately licensable.** The Open Source AI Definition lists Code and Parameters as distinct required components, with *"Parameters shall be made available under OSI-approved terms"* — it never says a code licence covers them.
- **The Linux Foundation built OpenMDW because code licences do not fit weights**, naming as an open problem *"whether the trained weights are licensable under typical understandings applicable to IP rights in software."*
- **There are real counterexamples.** BLOOM's licence states verbatim: *"Whereas the Apache 2.0 license was applicable to resources used to develop the Model, the licensing conditions have been modified for the access and distribution of the Model."* Stable Diffusion is MIT code with OpenRAIL-M checkpoints.
- **No court ruling or Copyright Office guidance addresses it.** That silence is the finding.

**Which is why link 3 carries the weight of this answer, not link 1.** The claim is not "the code is Apache-2.0 so the weights must be". The claim is "the party that published these weights declared them Apache-2.0, in machine-readable metadata, on the repo the ONNX is a format conversion of" — and a format conversion is a derivative work that Apache-2.0 §4 expressly permits distributing, provided recipients get a copy of the licence. **`onnx-community` ships no `LICENSE` and no `NOTICE`, so it cannot discharge §4 on our behalf. `AnnotateIt` does.**

### The switch is not only paperwork — the old export is built from broken weights

This was found while checking dates, and it is the more consequential half of this section.

`ustc-community/dfine-nano-coco`'s commit history:

```
2025-08-20  066438d3d8  Fix weights (#1)
2025-05-05  b913c7901a  Update README.md
2025-03-28  beb1274995  Add model from convert_d_fine_original_pytorch_checkpoint_to_hf.py
```

**`onnx-community/dfine_n_coco-ONNX` was exported 2025-04-30 — nearly four months before `Fix weights`.** `AnnotateIt/dfine-nano-coco-onnx` pins revision `066438d3d8f0da137a37b38fdf3368fd4afceced`, which is the fixed one, and publishes the source `model.safetensors` SHA-256 to prove it.

So every number in Q11 was measured against a superseded checkpoint. Re-measured on the **same 32 photographs, the same decode, the same threshold and NMS**:

| | onnx-community (2025-04-30) | AnnotateIt (fixed weights) |
|---|---|---|
| `person` present | 25 / 32 | **31 / 32** |
| `motorbike` present | 21 / 32 | **29 / 32** |
| **Usable kart-and-driver box** | **21 / 32** | **29 / 32** |
| …with the largest-box rule (below) | — | **31 / 32** |
| Photographs with nothing at all | 3 | 1 |
| Bytes | 15,258,358 | 15,434,935 |
| Warm inference, interleaved minimum | 28 ms | **27 ms** |

The typical union-box score rises from the 0.28–0.55 band to **0.66–0.90**. The failures Q11 documented individually are simply gone: the crowd-only shots, the marshal, the spectator, the head-clipped boxes — all now frame the kart and its driver.

**This clears saliency's 25 of 32**, which changes Q11's conclusion in one respect: the detector is no longer the weaker producer that survives on complementarity. It is the stronger one, and saliency covers its remaining failure. The ladder is unchanged; the ordering argument for it is now much easier.

### The largest-box rule, which Q11 left untested

Q11 listed "whether a largest-box rule beats a highest-score rule" as not determined. It was one line, so it was tested. Picking the **largest-area** vehicle box instead of the highest-scoring one changes the pick on 5 of 32 photographs:

- **Fixes 2** — both were the failure Q11 named, where a distant kart outscored the foreground subject and the frame walked away from it.
- **Neutral or better on 3** — one now spans both foreground karts rather than one.
- **Regressions: none.**

**29 / 32 → 31 / 32.** The only remaining failure is a single photograph where the detector produces no vehicle box at all, and saliency handles it.

### On depending on `AnnotateIt`

It is a small, unverified, single-member HF org. That is a real consideration and here is what was done about it rather than around it.

The repo meets **this repository's own bar for an export**, the one `packages/faces/scripts/export-edgeface.py` sets — a pinned upstream revision, and a verification that the export still matches the source model:

- Pinned source revision and the source `model.safetensors` SHA-256, both published in `PROVENANCE.md`.
- The exact `optimum-cli export onnx` command, published verbatim, with opset, atol and fixed 640×640.
- A PyTorch-versus-ONNX Runtime check in `validation-report.json`: **logits max abs diff 3.3×10⁻⁴, boxes max abs diff 2.5×10⁻⁵**, 5 detections against 5 on a named COCO reference image.
- `SHA256SUMS` for the artefact.

**The published SHA-256 was verified independently**: downloading `model.onnx` gives `b0ec2e5793f3a3cbd07440d098645a0e102cd450fb92f4f35e713f36e35d152e`, byte-for-byte the value in `validation-report.json`.

The graph contract is **identical** to the one Q11's decode was written against — `pixel_values [1,3,640,640]` in, `logits [1,300,80]` and `pred_boxes [1,300,4]` out, undecoded, no NMS. Opset 18 rather than 16, and the axes are fixed rather than dynamic, which costs nothing because the input was always 640×640.

Mitigations, in order:

1. **Vendor the file.** Commit the `.onnx` into the image at build time, as `models/` already does for YuNet and EdgeFace. Never fetch at runtime. This is already the repo's rule and it makes the org's future irrelevant.
2. **Record the SHA-256** in the export script alongside the pinned revision, and check it. Then a silent replacement upstream fails the build rather than shipping.
3. **If the owner would rather not depend on a third party at all** — run the export ourselves. `PROVENANCE.md` publishes the exact command and the pinned source revision, so this is reproducible and costs one script of the shape `export-edgeface.py` already has. That is the strongest option and the only one where the paper trail is entirely ours. It is a build-tooling decision, not a licence one: the licence is Apache-2.0 either way, because it comes from link 3.

### What to record

This does **not** need an ADR of the shape [ADR-0003](../adr/0003-face-recognition-licence-consent-and-threshold.md) has, because there is no risk being accepted. EdgeFace needed one because CC BY-NC-SA is a licence meco is knowingly non-compliant with. Here the licence is permissive, stated by the publisher of the weights, and satisfied by shipping the `LICENSE` file — which is an obligation to discharge, not a risk to accept.

What must be written down:

- **The Apache-2.0 `NOTICE`/attribution obligation is real.** §4 requires recipients of a derivative work to get a copy of the licence. Ship `LICENSE` beside the `.onnx` in the image and name D-FINE in whatever attribution surface meco has.
- **The rule that outlives this decision**: never an `_obj365` or `_obj2coco` checkpoint, for D-FINE or RT-DETR or anything else. That one belongs in `CLAUDE.md` or `DEPLOY.md`, because it is the trap that will be walked into again.

---

## Q13 — Is there one photograph that proves tag, blur and kart at once?

*Added 5 Sep 2026. The owner's demonstration wants a single image where a known Person is named, every stranger is blurred, and the kart and its driver are framed. **No CC0 or public-domain photograph does all three, and the reason is structural rather than a failure to look hard enough.** The closest honest answer is two photographs, and it is below.*

### What was searched

60 photographs, **CC0 and public domain only** — the same narrower-than-Commons bar `fixtures/karts/LICENCE.md` sets, because a fixture is a thing other code derives from. Twenty karting categories, four full-text searches, and the complete upload history of three photographers whose work looked promising.

Three specific leads were chased to the end and all three failed:

- **A third photograph of the podium driver.** `podium-trophy.jpg` and `-2.jpg` are the same person at two events and match at 0.783, so a third with a kart in it would have answered the whole question. Commons holds exactly two photographs of him.
- **The 1961 press pair** — two frames of one session, same two men, a kart in both, CC0. They do not match: best cross-frame cosine **0.385**, under `MATCH_THRESHOLD`. Monochrome press photography of two men in near-identical poses is not enough for EdgeFace.
- **The three photographs of one named driver** found through his photographer's uploads. All three are on track, helmeted, **zero faces detected** in two of them.

### Why no single photograph does it

The two requirements pull the camera in opposite directions, and it is measurable. Every row is different people in **one** photograph, so every score should be low:

| Photograph | Faces | Median face width | Worst cross-person cosine | Kart in frame |
|---|---|---|---|---|
| Team photo, 13 people | 13 | **86 px** | 0.391 | **no** |
| Podium, 3 drivers | 3 | 69 px | 0.314 | **no** |
| 1961 press, kart and men | 5 | 61 px | 0.186 | yes (0.44) |
| `paddock-mixed.jpg` | 8 | 54 px | **0.668** | yes (0.50) |
| `street-karting-crowd.jpg` | 12 | 31 px | **0.712** | yes (0.85) |

**A frame wide enough to contain a kart and its driver puts everyone else far enough away that their faces land in the band where EdgeFace stops discriminating.** A frame tight enough for reliable faces contains no kart. The two photographs with the strongest kart detections are the two with the worst face confusion, and that ordering is not a coincidence — it is the same lens.

This is the case [ADR-0003](../adr/0003-face-recognition-licence-consent-and-threshold.md) said its fixture set could not measure: *"no two people in the fixtures look alike and so nothing there is ever decided by the runner-up."* These photographs contain it.

### The merged rules hold — checked on a photograph they were never calibrated on

`street-karting-crowd.jpg` was found after [#38](https://github.com/timschoch/meco/pull/38) merged, so it is genuinely out of sample. Applying **both** of that fix's rules — `MIN_FACE_PX = 40` on the shorter side, and `NOT_A_FACE_THRESHOLD = 0.60` — to every embeddable face:

| Photograph | Embeddable | Enrollable after both rules | Cross-person pairs still over `MATCH_THRESHOLD` |
|---|---|---|---|
| `paddock-mixed.jpg`, as committed at 1400 px | 8 | 3 | **0 of 3** |
| the same photograph at the production 1600 px bound | 8 | 5 | **0 of 10** |
| `street-karting-crowd.jpg`, 1600 px | 12 | 2 | **0 of 1** |

**Zero false matches at every size.** The fix works, and it is worth recording *which half* does the work, because it is not the obvious one:

At the 1600 px bound — the size `src/faces.ts` actually feeds the embedder — **`MIN_FACE_PX` passes all eight** of `paddock-mixed`'s faces, and two cross-person pairs sit at **0.6489** and **0.5126**, both over threshold. What removes them is the Not-a-Face rule rejecting the two faces involved at 0.6563 and 0.6778. The size floor is not the guard here; the non-face check is, on inputs that are unambiguously faces. That is a stronger result for #38 than its own calibration claimed, and it is also a warning: the two rules are not independent, and loosening `NOT_A_FACE_THRESHOLD` would expose false matches that `MIN_FACE_PX` does not catch.

Note the resolution interaction while it is in view. `paddock-mixed.jpg` is safe as committed partly because 1400 px puts four of its faces under the floor. The same photograph handed to `/v1/crop` at its Commons original is bounded to 1600 px, where **all eight clear the floor**. A fixture that is smaller than production is a fixture that tests less than production.

### The recommendation: two photographs, and what each one is honestly for

**Photograph A — `street-karting-crowd.jpg`** (new, committed here). Public domain, 1600 × 1200, kept at native size on purpose because that is already the production bound.

- **Kart and driver selected**: 15 `motorbike` boxes, the two foreground karts at **0.85** and **0.74**, each with a driver in it.
- **Everyone blurred**: **12 faces** at 0.62–0.88. With no Person enrolled, every one is unknown and every one blurs.
- **Not for tagging.** Ten of the twelve are refused by `MIN_FACE_PX` or the Not-a-Face rule, which is the right answer for faces of 22–39 px.

**Photograph B — `podium-trophy.jpg` → `podium-trophy-2.jpg`** (already committed). The same driver at two events, **0.783**, faces around 100 px.

- **Tagged**: enrol from the first, Match in the second, `resolvedBy: "person"`.
- **Not for blur or kart**: one face each, no kart in either.

Run in that order the demonstration is honest and each claim is carried by the image that actually supports it. What it cannot claim is the three happening at once on one frame, and the table above is why that is a property of karting photography rather than of meco.

### If one image is genuinely required

`paddock-mixed.jpg` is the only fixture where a face, a stranger and a kart share a frame — 9 faces, `motorbike` at 0.50, a driver seated in the kart. A single-image demonstration is possible there **only** by enrolling one of its own faces, which proves that matching is self-consistent and nothing else. That is not a tag; state it as a self-match or leave it out.

### Two things found on the way that are not about fixtures

**`POST /faces/embed` fails the whole batch on one undersized warp.** `paddock-mixed.jpg` returns nine faces; asking for all nine gives `{"error":"The warped face came back 116x88, smaller than the 112px template."}` and **zero prints**. Embedding one face at a time returns eight. A caller enrolling from a group photograph gets nothing rather than the eight faces that were fine, and the error names a size without naming which face. Worth an issue: either embed what can be embedded and report the rest, or say which index failed.

**A helmet in a photograph is a detected "face" with no identity in it, and that is now visible in a fixture.** The one detection in the 2006 photograph checked here is the back of a crash helmet — 0.72 — which is the same shape as issue #34 and is caught by the merged rule.

### What could not be determined

- **Whether a Swiss Hutless photographer's own paddock work would behave like these.** Every photograph here is amateur or press. A team photographer standing three metres from their own driver produces exactly the frame this section says does not exist in Commons: kart, driver, crew faces, all large. **The structural claim is about what is publicly licensed, not about what is photographable** — and the right next step is to ask the brand for six real photographs rather than to search Commons again.
- **Whether the two enrollable faces in `street-karting-crowd.jpg` are the same person as anyone in another CC0 photograph.** Its photographer has one upload in total.

---

## What could not be determined

Listed because a gap that is not written down gets filled with a guess.

1. **Whether an EdgeFace helmet print carries the livery.** The 0.639–0.967 spread across 36 stranger pairs says *something* varies. No same-driver-same-helmet pair existed in the sample, so livery and lighting cannot be separated. This is the cheapest unrun experiment in the document and it might make Q7's third option free.
2. **Cold start with four models.** Nobody has run it. It is the constraint most likely to change the recommendation, and it decides fp32 versus q4f16.
3. **Whether a fine-tuned D-FINE-N actually finds a kart.** 42.8 COCO AP is a general-object number. A kart is small, low, partly occluded by its own driver, and often one of several. **No published number exists for this class**, and none can until the pilot runs.
4. **Minimum training-set size.** Q5 flagged it as unverified; still unverified. RF-DETR's docs state no minimum, HF notes a GPU is required.
5. **RTMPose-t's helmet confidence at scale.** Q5's finding rests on three photographs by one photographer in daylight. Not re-measured here. `fixtures/karts/` is where to widen it.
6. **VLM accuracy on race numbers.** No published figure for any VLM on this task. The $16 is a real price for an unmeasured result.
7. **Whether the 44-photograph sample resembles Swiss Hutless's own photography.** Wikimedia karting skews amateur and mid-2000s. A professional shooting one team at one circuit produces a tighter, more consistent distribution — which should help every number in Q1 and Q4, but that is a prediction, not a measurement.
8. **Whether fine-tuning is worth it at all**, now that the pretrained baseline is **31 of 32** rather than an assumption. That is the owner's call and the number under it is now high enough that the answer is probably no.
9. **Whether a per-image NonCommercial Flickr licence inside COCO flows through to a trained model.** Unresolved by COCO's own terms and by anything else found ([Q12](#q12--what-licence-is-the-model-in-production-under-and-where-is-that-written-down)). Industry-wide, identical for every COCO-pretrained detector, and so not a basis for choosing between them.
10. **What made the 2025-08-20 `Fix weights` commit necessary.** The effect was measured — 21 of 32 to 29 — but the commit carries no description and the cause was not established.

---

## Sources

Verified 5 Sep 2026. Face detection and Face Print numbers were measured against `https://meco-teal.vercel.app` on that date. [Q11](#q11--does-an-off-the-shelf-coco-detector-find-the-driver-with-no-fine-tuning)'s object-detection numbers were measured locally: `onnxruntime-node@1.29.0`, CPU execution provider, Apple M4 (10 cores), `sharp@0.35.3`, against `onnx/model.onnx` downloaded from the model card below.

**Models**
- D-FINE ONNX, recommended — <https://huggingface.co/AnnotateIt/dfine-nano-coco-onnx> (`LICENSE`, `PROVENANCE.md`, `validation-report.json`)
- D-FINE ONNX, licence-less, superseded weights — <https://huggingface.co/onnx-community/dfine_n_coco-ONNX> · base model <https://huggingface.co/ustc-community/dfine-nano-coco> · upstream <https://github.com/Peterande/D-FINE> (LICENSE, `README.md`, `tools/deployment/export_onnx.py`, `src/zoo/dfine/postprocessor.py`)
- RF-DETR — <https://huggingface.co/onnx-community/rfdetr_nano-ONNX> · <https://github.com/roboflow/rf-detr>
- RTMPose — <https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/> · <https://github.com/open-mmlab/mmpose> (`projects/rtmpose/README.md`, LICENSE)
- DEIMv2 (rejected, non-commercial) — <https://github.com/Intellindust-AI-Lab/DEIMv2/blob/main/LICENSE.md>
- DETRPose — <https://github.com/SebastianJanampa/DETRPose> · <https://huggingface.co/SebasJanampa/DETRPose_N_COCO>
- PP-OCRv6 — <https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx> · <https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx> · <https://arxiv.org/html/2606.13108v1>
- fast-plate-ocr (MIT, plate-shaped) — <https://github.com/ankandrew/fast-plate-ocr>

**Papers and datasets**
- RnD, motorcycle racer numbers — <https://arxiv.org/pdf/2311.09256>
- RBNR, marathon bibs — <https://people.csail.mit.edu/talidekel/papers/RBNR.pdf> · <https://people.csail.mit.edu/talidekel/RBNR.html>
- Jersey number recognition — <https://openaccess.thecvf.com/content/CVPR2024W/CVsports/papers/Koshkina_A_General_Framework_for_Jersey_Number_Recognition_in_Sports_Video_CVPRW_2024_paper.pdf>
- SVHN, non-commercial — <http://ufldl.stanford.edu/housenumbers/>
- Non-commercial jersey weights — <https://github.com/mkoshkina/jersey-number-pipeline> · <https://github.com/lukaszgrad/uncertainty-jnr>

**Licences and terms**
- COCO terms of use — <https://cocodataset.org/#termsofuse>
- Objects365 terms — <https://www.objects365.org/download.html>
- HF licence documentation — <https://huggingface.co/docs/hub/repositories-licenses> · terms — <https://huggingface.co/terms-of-service>
- OSI Open Source AI Definition — <https://opensource.org/ai/open-source-ai-definition>
- Linux Foundation OpenMDW — <https://huggingface.co/blog/linuxfoundation/openmdw>
- BLOOM, code licence ≠ model licence — <https://huggingface.co/bigscience/bloom-7b1/raw/main/LICENSE>

**Pricing**
- Claude — <https://platform.claude.com/docs/en/about-claude/pricing> · <https://platform.claude.com/docs/en/build-with-claude/vision>
- Gemini — <https://ai.google.dev/gemini-api/docs/pricing> · <https://ai.google.dev/gemini-api/docs/image-understanding>

**Photographs** — Wikimedia Commons, `Category:Karting` and siblings. The six committed under `fixtures/karts/` are listed with photographer and licence in that directory's `LICENCE.md`.
