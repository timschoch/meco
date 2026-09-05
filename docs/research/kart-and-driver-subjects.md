# Framing a Crop on a kart and its driver

*Research date: 5 Sep 2026. Two kinds of number appear below and they are always labelled. **Measured** means this study ran it against the deployed service at `https://meco-teal.vercel.app` and counted the answers. **Cited** means a primary source was read — model card, LICENSE file, official pricing page, paper — and the URL is at the bottom. A number with neither label does not appear.*

> **This is a point-in-time research snapshot, not the spec.** It answers the question [`docs/plans/faces-and-subject-aware-crop.md`](../plans/faces-and-subject-aware-crop.md) parked under "Later, not in this plan", and it assumes [`subject-aware-cropping.md`](./subject-aware-cropping.md) Q5 has been read. Domain terms are the ones defined in [`CONTEXT.md`](../../CONTEXT.md) — Source Image, Subject, Subject Box, Crop, Crop Anchor, Person, Face Print, Match, Face Blur — and are used exactly as defined.

---

## TL;DR

1. **A helmet is not a face, and meco already believes it is.** Measured on 32 on-track karting photographs: `POST /faces/detect` puts a box on the leading driver's head in **9 of 32 (28%)**, finds nothing at all in **19 of 32 (59%)**, and in **4 of 32 (13%)** returns a confident box on the *wrong* subject — a spectator in the crowd, or a distant driver while the foreground driver is missed. On 12 paddock and podium photographs with helmets off it is **12 of 12**. The face pipeline does not have a karting problem; it has a *visor* problem, and the paddock half already works.

2. **Person matching on a helmeted driver is not unreliable — it is actively wrong, and it is wrong today.** Measured: nine different drivers, nine helmets, 36 pairs. Median Face Print similarity **0.907**, minimum **0.639**. Twelve different people with helmets off: median **0.012**, maximum **0.388**. The same person photographed at two events, helmet off: **0.783**. `MATCH_THRESHOLD` is **0.50** (`src/people.ts:278`). **Every one of the 36 helmet pairs clears it, and 28 of 36 sit above the genuine same-person score.** EdgeFace collapses every full-face helmet onto approximately one identity. With a single Person enrolled there is no runner-up, so `MATCH_MARGIN` never fires and every helmeted stranger becomes a Match. This breaks `pinTo: "person"` and it breaks **Face Blur** — see [Q2](#q2--identity-the-measurement-that-decides-it), which is the one part of this document that is a bug report rather than a plan.

3. **EdgeFace is irrelevant to the racing case. Say it plainly.** There is no facial skin behind a closed visor, so there is nothing for a face recogniser to be right or wrong about. It stays relevant to the paddock, the podium and the team photograph, where it already works.

4. **The thing that ships this week needs no new model.** Measured: `pinTo: "attention"` — the saliency producer that is already merged — frames the kart and its driver well in **25 of 32**, acceptably in **29 of 32**, and loses the driver's head in **3 of 32**. That is not close to the face producer's 9 of 32. The change is one line of policy, not one line of ML: **stop letting a face outrank saliency when the "face" is a helmet.**

5. **The recommendation, when the 9% matters: a fine-tuned D-FINE-N kart detector feeding RTMPose-t.** Both Apache-2.0, both with a real ONNX artefact, **+6.0 MB and +13.4 MB** on an image that is 129 MB in the registry today. That is the plan's own proposal and this study did not find a reason to change it — but it did find that **two of the facts Q5 recorded about D-FINE-N are wrong**, and the correction costs real work. See [Q5](#q5--the-recommendation-and-the-two-q5-facts-that-turned-out-to-be-wrong).

6. **Second choice: RF-DETR-Nano, and it lost on size, not on accuracy.** The premise that killed it in Q5 — "no pre-exported ONNX" — is now false. `onnx-community/rfdetr_nano-ONNX` exists, is properly tagged `apache-2.0`, and is **19.0 MB at q4f16 against D-FINE-N's 6.0 MB**. It buys +5.7 COCO AP for 3.2× the bytes and an identical amount of TypeScript decode work. Cited. Take it only if a pilot shows 42.8 AP cannot find a kart.

7. **Reading the race number will not identify a driver, and the honest version of that sentence is uncomfortable.** The one published dataset with this exact geometry — professional photographers, numbers on a vehicle panel *and on the helmet*, motion blur, glare, occlusion — reports state-of-the-art scene-text spotters at **0.12–0.15 end-to-end F1 out of the box** and **0.527 after fine-tuning on 2,400 in-domain images**, with the authors writing that even the fine-tuned models "fall short of real-world viability". Cited. Do not put OCR in the crop path. If the number is wanted, buy it offline: **$16 per 100,000 photographs** on Gemini 2.5 Flash-Lite, cited, and design the consumer to accept "unknown" about half the time.

8. **Nothing in the recommendation is a rewrite.** `CROP_PRODUCERS` in `src/crop-solver.ts:33` is a `const` array and the solver reads `leader.producer` generically at line 500. A `kart` producer is one string in that array, one number in `PRIORITY` (`src/crop.ts:84`), and one branch in `subjectBoxes`. **`src/crop-solver.ts` needs no logic change at all** — ADR-0001's purity holds.

### The recommendation in one table

| | What | Added weight | When |
|---|---|---|---|
| **Now** | Saliency outranks a helmet: don't let the face producer lead when the detected "face" is not a face | **0** | This week |
| **Now** | Refuse to Match a face whose print is helmet-shaped — or gate Matching on the paddock case | **0** | Same change |
| **Next** | Fine-tuned D-FINE-N kart detector → `kart` Subject Box | +6.0 MB (q4f16) | After a labelling pass |
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

**It loses on 13 MB.** At q4f16 it is 3.2× the bytes for +5.7 AP, on a container that scales to zero and pays its cold start on a real request. And the one advantage Q5 imagined for D-FINE — a decoded graph — turns out not to exist, so RF-DETR's "raw tensors" objection no longer distinguishes them: **both hand back undecoded `logits` and `pred_boxes` and both need the same TypeScript**. The shape-ambiguity trap Q5 warned about is real and is now the only differentiator, and it is a code-review problem, not an architecture one.

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
| **D-FINE-N q4f16 + RTMPose-t** ← recommended | **+19.4 MB** | Two more ORT sessions. Not measured; must be measured before merge |
| D-FINE-N fp32 + RTMPose-t | +28.6 MB | as above |
| RF-DETR-Nano q4f16 + RTMPose-t | +32.4 MB | as above |
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

## What could not be determined

Listed because a gap that is not written down gets filled with a guess.

1. **Whether an EdgeFace helmet print carries the livery.** The 0.639–0.967 spread across 36 stranger pairs says *something* varies. No same-driver-same-helmet pair existed in the sample, so livery and lighting cannot be separated. This is the cheapest unrun experiment in the document and it might make Q7's third option free.
2. **Cold start with four models.** Nobody has run it. It is the constraint most likely to change the recommendation, and it decides fp32 versus q4f16.
3. **Whether a fine-tuned D-FINE-N actually finds a kart.** 42.8 COCO AP is a general-object number. A kart is small, low, partly occluded by its own driver, and often one of several. **No published number exists for this class**, and none can until the pilot runs.
4. **Minimum training-set size.** Q5 flagged it as unverified; still unverified. RF-DETR's docs state no minimum, HF notes a GPU is required.
5. **RTMPose-t's helmet confidence at scale.** Q5's finding rests on three photographs by one photographer in daylight. Not re-measured here. `fixtures/karts/` is where to widen it.
6. **VLM accuracy on race numbers.** No published figure for any VLM on this task. The $16 is a real price for an unmeasured result.
7. **Whether the 44-photograph sample resembles Swiss Hutless's own photography.** Wikimedia karting skews amateur and mid-2000s. A professional shooting one team at one circuit produces a tighter, more consistent distribution — which should help every number in Q1 and Q4, but that is a prediction, not a measurement.
8. **The D-FINE ONNX licence chain.** Apache-2.0 is established for the upstream code and the base model. The artefact meco would ship declares nothing and links to a 404. Not a blocker; is a thing to write down before it ships.

---

## Sources

Verified 5 Sep 2026. Everything under "measured" in this document was run against `https://meco-teal.vercel.app` on that date.

**Models**
- D-FINE ONNX — <https://huggingface.co/onnx-community/dfine_n_coco-ONNX> · base model <https://huggingface.co/ustc-community/dfine-nano-coco> · upstream <https://github.com/Peterande/D-FINE> (LICENSE, `README.md`, `tools/deployment/export_onnx.py`, `src/zoo/dfine/postprocessor.py`)
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

**Pricing**
- Claude — <https://platform.claude.com/docs/en/about-claude/pricing> · <https://platform.claude.com/docs/en/build-with-claude/vision>
- Gemini — <https://ai.google.dev/gemini-api/docs/pricing> · <https://ai.google.dev/gemini-api/docs/image-understanding>

**Photographs** — Wikimedia Commons, `Category:Karting` and siblings. The six committed under `fixtures/karts/` are listed with photographer and licence in that directory's `LICENCE.md`.
