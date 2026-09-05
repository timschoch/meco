# ADR-0003 — EdgeFace's licence, the consent rule, and the match threshold

Status: **accepted, 5 Sep 2026**. Plan: [`../plans/faces-and-subject-aware-crop.md`](../plans/faces-and-subject-aware-crop.md) phase 3, step 14. Builds on [ADR-0002](0002-meco-faces-as-a-separate-service.md), which put the recognition model in its own service and left this owed.

Three decisions that all bear on one thing: meco can now put a name on a face. The first says under what licence it may, the second under what circumstances it may, and the third how sure it has to be.

## Context

Recognition arrived in three tickets. #13 gave a Brand People, Reference Photos and Face Prints; #12 gave a Crop the ability to blur a face; #14 joined them, so a Crop can pin on a named individual and hide everyone else. Everything below became true at that join and not before: until a Face Print could be compared with another, none of it was a decision anyone had to have made.

## Decision 1 — the EdgeFace weights are used under CC BY-NC-SA, as an accepted risk

`edgeface_xs_gamma_06` is code under BSD-3 with **weights published under CC BY-NC-SA 4.0** on the Hugging Face model cards. Non-commercial. meco is a tool for producing marketing images, which is commercial by intention, so the two do not sit comfortably together.

The plan took this decision on 4 September and recorded it in one line: *"The CC BY-NC-SA weight licence on the Hugging Face model cards is accepted as an MVP risk. Record as ADR-0003 before v3 ships."* This ADR records that decision. It does not re-open it, and nothing measured since has changed the picture.

What makes it an acceptable risk rather than a blind one:

- **The exposure is bounded by the accuracy, not by the deployment.** meco runs for one operator and their own Brands. There is no third party licensing recognition from meco.
- **The replacement is a file.** ADR-0002 put every model behind `/detect` and `/embed` and made meco reach the service by configuration. Changing the recognition model is `packages/faces/models/`, a re-run of `export-edgeface.py`, and nothing else — no change to meco, its API, or its storage.
- **What the replacement would cost is known and written down** — see Decision 3, and the consequence below on re-computation.

The obligation this leaves is to revisit before meco is offered to anyone else, and the trigger is commercial rather than technical: another operator, or a paid tier.

## Decision 2 — nobody is enrolled without consent, and the record says who said so

A Reference Photo is a photograph of a named individual and a Face Print is a biometric template of them. Neither is a Render. So:

- **Only a person who agreed may be enrolled.** Not "a photograph the operator has the rights to" — a public-domain licence says a photograph may be republished, it does not say its subject agreed to be recognised by software. The two are different permissions and only one of them is about the person.
- **The agreement is recorded against the photograph, not asserted in a document.** `consentAt` on the Reference Photo record, set when the enroller says so, absent when nobody did. Absent is a fact worth being able to read back rather than a default worth inventing, which is why it is optional and never filled in by meco.
- **Deletion is a property of the store and not a promise.** Everything about a Person lives under `people/<brand>/<personId>/`, `deletePerson` walks that prefix, and the Gallery never lists it. See `src/people.ts`, and DEPLOY.md for the operator's path.
- **A Reference Photo has no address that hands it over.** It is in the private Blob store; meco serves the bytes only to a caller carrying the token. #13 closed the plan's open question 1 that way.
- **The fixtures are not a precedent.** `fixtures/faces/` holds five public-domain NASA photographs used to test the detector, the embedder and now the threshold. Nobody in them is enrolled, no Person record exists for any of them, and the Face Prints computed from them live for the length of a test run. `fixtures/faces/LICENCE.md` says so where somebody reaching for another photograph would read it.

## Decision 3 — the threshold is 0.50 and the margin 0.05, calibrated on the fixture set

A face is a **Match** only when both hold:

- its best cosine similarity against the Brand's Face Prints is at least **0.50**, and
- that best beats the **second-best Person** by at least **0.05**.

Anything else is unknown. Open-set: "nobody" is a valid answer and, on any photograph containing a stranger, the common one.

The runner-up is the best *other Person*, never the second-best Face Print. Otherwise a Person with four Reference Photos would be their own runner-up and could never clear the margin — the more meco knew about someone, the less it could recognise them.

### Where the numbers come from, and what they are worth

**Calibrated on the committed fixture set in `fixtures/faces/`, not on the operator's own enrolled photographs.** No Person is enrolled anywhere, so there are none to calibrate on. A number whose provenance is recorded is a fact; one whose provenance is implied is a trap, so this sentence is the point of this section.

`pnpm test:match` (`scripts/match-calibration.ts`) sweeps the threshold over the fixture Face Prints in `fixtures/faces/face-prints.json`, and is in the verification gate. Measured 5 September 2026 on nine faces of seven people, **at the 1600 px bound `src/faces.ts` applies to a Source Image** — the resolution the threshold is used at, which issue #53 established and which the row below records so no reader has to ask:

| | |
|---|---|
| same person, worst of 3 pairs | **0.7263** |
| different people, best of 33 pairs | **0.2979** |
| gap | **0.4284** |
| thresholds with zero false and zero missed Matches, over 66 trials | **0.30 – 0.80** |
| shipped threshold | **0.50** — the middle of that band, and the point furthest from both mistakes |
| clearance above the best stranger | 0.2021 |
| clearance below the worst same-person pair | 0.2263 |
| resolution the fixtures were measured at | **1600 px long edge**, `LONG_EDGE` in `src/faces.ts` |

#### Re-measured at the production bound, and nothing moved

Issue #53 asked the question #42 forced: these numbers were calibrated on fixtures committed at 1400 px while `src/faces.ts` bounds a Source Image to 1600 px. #42 had just shown that was not a formality — the Not-a-Face band did not shift at the bound, it **inverted**. So the fixtures were re-derived and the sweep re-run:

| | 1400 px | **1600 px** | moved by |
|---|---|---|---|
| same person, pair 1 | 0.8689 | 0.8681 | −0.0008 |
| same person, pair 2 | 0.8182 | 0.8228 | +0.0046 |
| same person, worst pair | 0.7304 | **0.7263** | −0.0041 |
| different people, best of 33 | 0.2855 | **0.2979** | +0.0124 |
| gap | 0.4450 | **0.4284** | −0.0166 |
| clean threshold band | 0.30 – 0.80 | **0.30 – 0.80** | unchanged |
| margin sweep | flat, 0 to 0.4 | flat, 0 to 0.4 | unchanged |
| Not-a-Face band | −0.0177 | **−0.0177** | unchanged |

The last row is in the table because #53 asked for it, and it needs a caveat to
be read correctly: that band is set by the **kart** fixtures, which #42 had
already moved to the bound. Re-deriving the face fixtures could not move it and
did not. It is repeated here so the two calibrations can be read together —
the identity one confirmed, the non-face one still inverted.

**Every movement is smaller than the 0.019 a JPEG re-encode alone moves a Face Print** (see the precision section in the amendment below). The clean band is identical to the hundredth, 0.50 is still its midpoint, and the margin table is still flat. **No constant changes, and this is a result rather than the absence of one**: the identity threshold is now confirmed at the resolution it is applied at, instead of merely never having been re-checked there.

**Why this survived and the Not-a-Face band did not** is worth stating, because it is the general lesson. The identity separation is **0.43** wide; the non-face separation was **0.04**. A perturbation of about 0.02 — which is what changing the resolution turned out to be worth — is invisible against the first and fatal to the second. A threshold's fragility to this class of change is a property of its band, and the band is the number to look at before assuming a re-measurement is a formality.

**One thing that did move, and it is larger than the encode noise.** Re-deriving the fixtures moved the detected landmarks by well under the 3 % the detect test allows — every box still matches the human's — and yet the aligned 112 × 112 squares changed enough that the Face Print of one face shifted by **0.065** of cosine against its old reference. Geometry moves a print further than encoding does. That is why `fixtures/faces/aligned/` and `edgeface-reference.json` have to be regenerated together whenever the fixtures move, and why `pnpm test:embed` checks the squares before it checks the prints.

The 66 trials are every fixture face against every gallery, including a gallery holding a single Person — which is the case with no runner-up at all, where the threshold has to hold up alone. A face is never asked about against a gallery containing its own photograph.

**The margin is not calibrated, and cannot be on this set.** Its table is flat at every value from 0 to 0.4, because no two people in the fixtures look alike and so nothing there is ever decided by the runner-up. A margin guards against two enrolled People of one Brand being told apart by the third decimal of a cosine, and a set that does not contain that case cannot measure the guard against it. 0.05 is a guard at the size of run-to-run noise, chosen and not measured. The script prints the flat table rather than implying a measurement it did not make.

**A false Match is the failure that matters.** Not a wrong number in a log: the wrong person's face left sharp in a published post. So the sweep fails the run on a single false Match and merely reports a missed one.

### What re-calibration needs

- Real enrolled People, photographed the way the operator actually photographs them. The fixtures are studio and launch-pad photographs of astronauts; a phone snapshot at an event is a harder problem, and the honest expectation is that same-person scores fall.
- At least one pair of People who resemble each other, or the margin stays a guess.
- Re-run `pnpm test:match`, move the constants in `src/people.ts`, and edit the table above. Both constants are exported and documented at their definition, so there is one place to change.

## Amendment, 5 Sep 2026 — the threshold holds only for inputs that are faces

Decision 3 is calibrated on `fixtures/faces/`, every photograph of which is an uncovered human face. It says nothing about what happens when the thing handed to the matcher is not a face, and issue #34 found out in production: a Person was enrolled from the **back of a crash helmet**, and a different human wearing a helmet matched them at **0.7092**. The Crop pinned on a stranger and `blurUnknownFaces` blurred nothing at all — the privacy option failing open, silently, on the brand that needs it.

**The threshold is not the lever and was not moved.** [`../research/kart-and-driver-subjects.md`](../research/kart-and-driver-subjects.md) measured nine helmets over 36 pairs at a median cosine of **0.907** and a minimum of **0.639**, against a genuine same-person pair at 0.783. No cut separates those two populations, and raising 0.50 far enough to exclude helmets would start refusing real people. Decision 3 stands exactly as written, with one sentence added to it: **it is a rule about two faces, and it is only meaningful for inputs that are faces.**

### What enforces that

Two conditions, both in `src/people.ts`, asked at enrolment and again at match time. A face that fails either can never be a Match; it is still detected, still a Subject Box, and still hidden by Face Blur.

1. **`MIN_FACE_PX`, now applied when matching and not only when enrolling.** Its reasoning always covered both — below 40 px EdgeFace is handed an upsampled blur and returns a print of the interpolation.
2. **`NOT_A_FACE_THRESHOLD = 0.60` against the committed Not-a-Face Prints** in `src/not-a-face-prints.ts`. A Face Print at or above 0.60 to one of them carries no identity.

`matchFaces` applies the same two conditions to the **enrolled prints** as well as to the detection, and both halves are needed. A helmet detection against a real Person is already safe — the research measured helmet against face at 0.433 at worst over 108 pairs. The dangerous direction is the other one: `paddock-mixed`'s driver is a real face and scores **0.5091** against the committed helmet print, over the 0.50 threshold. No check on the detection can catch that, because the detection *is* a face. Only dropping the Reference Photo can, which is also what protects every Brand that enrolled before this rule existed.

### Where 0.60 comes from

A **Not-a-Face Print** is a committed Face Print of something that is not an identifiable face. One is shipped: `on-track-rear-helmet.jpg#0`, the back of a crash helmet. It holds no human face at all, which is why it and not `paddock-mixed`'s man seen from behind is the artefact in the repository.

`pnpm test:match` measures it over 21 hand-classified detections, ground truth in `fixtures/karts/expected.json`. Counting only detections that clear `MIN_FACE_PX`:

| | |
|---|---|
| 11 real faces of 57 px or more, closest any gets | 0.0971 |
| **real face, closest any gets** | **0.6542** — `paddock-mixed#8`, a small child looking down, 40 px |
| **nearest non-face** | **0.6365** — `paddock-mixed#7`, a man seen from behind, 52 px |
| `on-track-visor-open`, held out of the reference set | 0.6935 |
| shipped threshold | **0.60** |
| clearance below the nearest non-face | **0.0365** |
| overlap with the closest real face | **0.0177** — the threshold refuses it |
| **band** | **−0.0177. There is none.** |

Both rejections are out of sample. The reference is never compared with itself.

**Corrected 5 Sep 2026, second time — the band closes at the size production uses.**
The numbers above replace a set measured on fixtures committed at a 1400 px long
side, while `src/faces.ts` bounds a Source Image to 1600 px. Issue #42 re-derived
the fixtures at that bound, and the separation this ADR reported turns out to
have been a property of the fixtures rather than of the rule.

What changes: `paddock-mixed#8` is 36 px at 1400 px and `MIN_FACE_PX` refuses it
before its print is ever consulted. At 1600 px the same detection is 40 px, clears
the floor, and scores **0.6542** — above the furthest non-face at 0.6365. **No
value of `NOT_A_FACE_THRESHOLD` accepts it and still refuses that non-face.** The
old table's "clearance above the closest real face, 0.0399" was measuring a face
that production-sized input does not put in that position.

**0.60 still ships, and the reason is narrower than before.** It is *safe*, not
*centred*: it refuses every non-face with 0.0365 to spare, which is the mistake
this ADR says must never happen. The price is that it also refuses one real face.
That is the cautious mistake, it is named in the recall ledger below, and
`scripts/match-calibration.ts` now asserts the exact set rather than asserting
there is none — so refusing a *different* face fails the run.

**What this does not mean.** Nothing about production behaviour changed here.
`src/not-a-face-prints.ts` is byte-identical: the reference photograph is
`on-track-rear-helmet.jpg`, which is 600 × 400 and was already what production
sends. Callers have always sent 1600 px. The suite was measuring a smaller world
than the one meco runs in; now it is not.

**One thing issue #42 did not settle, recorded so it is not mistaken for settled.**
(`fixtures/faces/` was the other, and issue #53 has since re-derived it at the
bound and re-run Decision 3's calibration — see above. The size rule and its
enforcement now cover both fixture directories.) The two cosines issue #42 asked to have
asserted — 0.6489 and 0.5126 — **do not reproduce against the committed bytes**.
They were measured on a re-encode made while investigating; against the fixture
now on disk the only pair over `MATCH_THRESHOLD` is 0.5628, and it is a face
agreeing with a non-face rather than two faces. `scripts/match-calibration.ts`
asserts the structure that survives and says so in as many words.

**The open question this leaves.** A threshold with no band is a threshold that
cannot absorb a new fixture. If the reference set grows — and
["What this does not fix"](#what-this-does-not-fix) says it should — the next
non-face may land below 0.6542 and there will be no cut at all. Two levers exist
and neither is free: raise `MIN_FACE_PX` above 40, which refuses more small real
faces; or commit more Not-a-Face Prints so each candidate is judged against its
own kind, which needs CC0 or public-domain photographs (see the licence
constraint above). Deciding between them is not this ADR's to make today, but it
should be made before the set grows, not after.

**Corrected 5 Sep 2026.** This table previously closed the band from below with
*0.639*, the worst helmet-to-helmet pair over the 36 in the research, and gave a
clearance of 0.039. That is the wrong quantity. 0.639 is a distance between two
helmets **neither of which is the reference** — it belongs to `on-track-visor-open`
against a photograph not committed here — and the rule scores a candidate against
the reference, not against another candidate. The lower edge is the nearest
non-face *to the reference*, which this table already held: **0.6935**, for a
clearance of **0.0935**.

The deduction that motivated the old row can now be dropped, because the thing it
was standing in for has been measured. `on-track-rear-helmet.jpg` is one of the
nine helmet detections in the research, so the eight pairs joining it to the other
eight are directly computable, and
[the research records them](../research/kart-and-driver-subjects.md#the-nine-named--and-what-the-not-a-face-rule-actually-measures):
**eight of eight are refused at 0.60**, from 0.7092 up to 0.9629. No known helmet
sits nearer to the reference than the two already in the table. Note also why the
reference set cannot simply be widened: **two of those nine are CC0 and both are
already committed here**; the other seven are CC BY-SA and are barred by
`fixtures/karts/LICENCE.md`.

### What this ADR is choosing, and admitting

**0.0365 of room in one direction and none in the other, against 0.2145 and 0.2304 for `MATCH_THRESHOLD`.** Stated as movement, which is the only way it is not read backwards:

- **0.60 can rise by 0.0365** before it stops refusing the nearest non-face.
- **0.60 cannot fall at all** without refusing more real faces, and it is already refusing one at 0.6542.

So there is no interval to sit in the middle of, and the binding constraint is *real faces* — the opposite of what the old *0.639* row implied. The tight side is the side where the mistake is a face going unnamed rather than a stranger being named. That is the cheaper mistake to be close to, which is the only reason this operating point is defensible at all.

That asymmetry is accepted because the two mistakes are not the same size: a face wrongly refused is blurred and unnamed, which is cautious; a non-face wrongly accepted is a stranger's name on a published photograph with their face left sharp, which is the bug reported. `src/crop.ts` already states the principle — *"who may be shown is not [a composition choice]"*.

The tightness is real and it is a property of small faces. Above 57 px the two populations are **0.5394** apart, as clean as Decision 3's — 11 faces, the closest at 0.0971. Everything difficult about this threshold lives at 40–57 px, where a small face and a helmet genuinely converge. That is the fact `MIN_FACE_PX` was written for, and it is why the floor now runs when matching as well as when enrolling.

**What the floor no longer does is separate this fixture set.** At the production bound every detection in it clears 40 px, so `MIN_FACE_PX` excludes nothing and the print rule is doing all of the work. `scripts/match-calibration.ts` asserts exactly that, because the tempting reading of the old numbers — "the size rule catches those anyway, so the print threshold has slack" — is false, and acting on it would loosen the only rule holding the set apart.

### How much precision these numbers actually carry

Every figure above is quoted to four decimals and **the input does not carry four decimals.** A Face Print is not stable across a JPEG round trip, and the fixtures are re-encodes: `fixtures/karts/LICENCE.md` records that each was downscaled and saved at quality 88.

Measured, on the same photographs at two different encodes:

| | |
|---|---|
| `on-track-rear-helmet.jpg` committed, against a print of the Commons original | **0.9689** |
| `on-track-visor-open.jpg` committed, against a print of the Commons original | 0.9973 |
| **the reference-to-`visor-open` pair, both committed** | **0.6935** |
| the same pair, reference committed against the Commons original | 0.7092 |
| the same pair, both from Commons originals | 0.6901 |

**One pair moves 0.019 on encoding alone** — about half the 0.0399 clearance above the closest real face. So `NOT_A_FACE_THRESHOLD` is a **rounded** constant, not a tuned one, and the fourth decimal of any number here is noise. The committed encode happens to give the most conservative reading of the three, which is the right accident to have, but it is an accident.

Two rules follow, and they are the point of this section:

- **Never re-encode a committed fixture** without re-running `pnpm test:embed`. The numbers in `fixtures/karts/face-prints.json` are properties of those exact bytes.
- **Do not tune 0.60 against a difference smaller than 0.02.** There is nothing there to tune.

**Four other signals were measured and rejected**, all on the committed fixtures, and they are recorded because each is the obvious next suggestion:

| Signal | Helmet | Real faces | Verdict |
|---|---|---|---|
| Landmark geometry — eyes above nose above mouth, symmetry, proportion | nose asymmetry 0.356, mouth drop 1.064 | 18 real faces span 0.001–0.442 and 0.828–1.527 | **Dead.** The helmet is *interior* to the real faces on both axes — two are more asymmetric and seven have a deeper mouth drop — so a cut in either direction reaches a real face first. `pnpm test:match` recomputes this from the committed landmarks |
| Detection score | 0.649, 0.808 | 0.661 – 0.947 | Dead, and the ticket said so |
| Raw embedding magnitude, the usual quality proxy | 0.27, 0.30 | 0.27 – 0.34 | Dead |
| Flip consistency of the print | 0.9987, the highest of all 21 | 0.9858 – 0.9973 | Dead, and backwards |

The first of these is what issue #34 asked for. It does not work, and the measurement is in the doc comment on `NOT_A_FACE_THRESHOLD`.

### The recall this costs, stated plainly

The issue asked that the rule "accept all 6 real faces and the 9 paddock faces". It accepts the 6. Of the nine detections in `paddock-mixed.jpg`, at the size production sends, **six can still carry a name**:

| | |
|---|---|
| `#0` 66 px, `#2` 49 px, `#3` 42 px, `#4` 55 px, `#5` 42 px, `#6` 43 px | matchable |
| `#8` 40 px — a real face, a small child looking down | **refused by the print at 0.6542.** The one recall loss, and `scripts/match-calibration.ts` asserts it by name |
| `#7` — a man seen from behind | classified not a face in `fixtures/karts/expected.json`, and refused by the print |
| `#1` — a real face | has no Face Print at all: the ArcFace warp cannot cut a 112 px square from its landmarks, so `/embed` refuses it. Unchanged by this ADR, and pre-existing |

**These numbers are better than the ones this section carried until issue #42, and for an uncomfortable reason.** The old ledger recorded four real faces refused on size at 36 px and only three matchable. Those 36 px measurements came from fixtures committed below the production bound; at 1600 px the same four faces are 42–49 px, clear `MIN_FACE_PX`, and are matched. The recall regression this section was written to own was half an artefact of the fixture size, and the half that is real is now one face rather than four.

Every refused detection is still detected, still a Subject Box and still blurred, so the loss is of naming and not of protection — but it is a loss, and a reader should not have to derive it from a table.

### The boundary this draws through helmeted drivers, and why it looks inconsistent

Two subjects in the fixtures are the same kind of thing — **a driver in a helmet with the visor up, face visible** — and the rule treats them oppositely:

| | Against the reference | Size | Outcome |
|---|---|---|---|
| `paddock-mixed.jpg#4`, driver, visor up, facing the camera | **0.5091** | 55 px | **accepted** — may be enrolled and named |
| `on-track-visor-open.jpg#0`, driver, visor up | **0.6935** | 100 px | **refused** — may never be a Person |

0.18 of cosine apart, opposite answers, and the larger, sharper face is the one refused. A reader who meets these two without warning will read it as a bug. It is not, and the ADR should say so here rather than leave it to be discovered.

**Both outcomes are intended, and the difference is how much helmet is in the frame.** `paddock-mixed`'s driver is photographed from the front at conversational distance: the open visor fills most of the box and the shell is mostly outside it. `on-track-visor-open`'s driver is photographed on track: the box is dominated by shell, chin bar and visor surround, with the face a small part of it. The reference print is *the back of a helmet* — shell and nothing else — so the second box is genuinely closer to it. The rule is measuring what it claims to measure.

**The cost is real and belongs in Decision 3's ledger.** A Swiss Hutless driver photographed on track with the visor up **cannot be enrolled as a Person**, and cannot be named in another photograph. Only paddock and podium photographs, where the helmet is off or small in frame, can enrol anybody. That is a narrower promise than "we can recognise your driver", and it is the promise the shipped code makes.

**What would move the boundary**, in order of preference:

1. **Enrol from a helmet-off photograph.** The paddock and podium case works today and is what enrolment should use. This is a documentation and UI matter, not a threshold one.
2. **More reference prints.** One reference of a bare shell makes shell-dominated boxes the nearest thing to a non-face. Several references spanning shell, visor-up and rear-of-head would let each be judged against its own kind. `fixtures/karts/expected.json` is where a new one is classified — and note the constraint from the correction above: **CC BY-SA photographs cannot be committed**, so new references have to be CC0 or public domain.
3. **Not by moving 0.60 up.** The gap between these two looks tuneable and is not: `paddock-mixed#8` is a real face at **0.6542**, between them, and at the production bound it is 40 px and squarely in scope. Raising the threshold to accept `on-track-visor-open`'s driver would accept the man seen from behind at 0.6365 first. There is no cut that improves this boundary — only more reference prints, or a different size floor.

### What this does not fix

- **A helmet is still detected and still frames a Crop.** `pinTo` and the producer priorities are untouched; the research document's Q4 proposal — a per-Brand `pinTo` default — is separate work.
- **One reference print is thin coverage.** It catches every helmet the fixtures and the research contain — measured, eight of eight at 0.7092 and above, not deduced from the 36-pair floor. It is not a general non-face detector: nothing here says what it does with a bare head, a mannequin or a printed face on a banner, and the set should grow as other non-faces are found. `fixtures/karts/expected.json` is where a new one is classified; `pnpm --filter meco-faces dump:karts` regenerates the artefacts.
- **The prints are model-specific and meco cannot check them.** Swapping the embedder would move every print at once and meco would silently stop refusing helmets. `pnpm test:embed` re-embeds the fixtures and fails if the committed numbers have drifted, which is the only place that check can live (ADR-0002).

## Consequences

- **A stored Face Print carries no model tag.** `/embed` does not say which network produced it, and meco does not invent one — a tag meco wrote would be a claim about the service's internals that meco cannot check. The consequence is operational and unavoidable: **if the recognition model ever changes, every stored Face Print must be recomputed**, because a print from one network is meaningless against a print from another. There is no migration that reads the old prints; the Reference Photos are still in the store, so re-enrolment is a re-embed of what is already there, and it is the only path. This is also the real cost of Decision 1's "the replacement is a file".
- **The threshold and the margin are two exported constants**, `MATCH_THRESHOLD` and `MATCH_MARGIN` in `src/people.ts`, read by the service and by the sweep. Nothing else may hold a copy.
- **The sweep does not load a model.** It reads `fixtures/faces/face-prints.json`, written by meco-faces' own ONNX path and kept current by `pnpm test:embed`, which re-embeds every fixture face and fails if the file has drifted. That is what lets a calibration live in meco while the embedder lives in the other package (ADR-0002), and what stops a stale file from producing a beautiful table about numbers nobody computes any more.
- **`persons` narrows at the end, not at the start.** A Crop naming Person ids is still compared against the Brand's whole gallery, and a winner nobody asked for is refused rather than the request being answered from a subset. Comparing against a subset would hand a face that really belongs to an unlisted Person to whichever listed Person scored highest.
- **Matching never crosses a Brand.** The Face Prints come from a listing of one Brand's prefix, so isolation is a property of which keys were read rather than a filter applied after. Naming another Brand's Person is refused by name, not silently ignored.
- **A Crop with no Brand names nobody**, and then Face Blur hides every face — which is exactly what a Crop did before People existed.
- **The Annotation stays free of names.** It is cached under the hash of the image bytes and which faces are Matches depends on the Brand that asked, so a name written into it would hand the next Brand somebody else's answer. `find_subjects` reports Matches beside the Annotation, keyed by region id, and never inside it.
