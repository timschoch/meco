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

`pnpm test:match` (`scripts/match-calibration.ts`) sweeps the threshold over the fixture Face Prints in `fixtures/faces/face-prints.json`, and is in the verification gate. Measured 5 September 2026 on nine faces of seven people:

| | |
|---|---|
| same person, worst of 3 pairs | **0.7304** |
| different people, best of 33 pairs | **0.2855** |
| gap | **0.4450** |
| thresholds with zero false and zero missed Matches, over 66 trials | **0.30 – 0.80** |
| shipped threshold | **0.50** — the middle of that band, and the point furthest from both mistakes |
| clearance above the best stranger | 0.2145 |
| clearance below the worst same-person pair | 0.2304 |

The 66 trials are every fixture face against every gallery, including a gallery holding a single Person — which is the case with no runner-up at all, where the threshold has to hold up alone. A face is never asked about against a gallery containing its own photograph.

**The margin is not calibrated, and cannot be on this set.** Its table is flat at every value from 0 to 0.4, because no two people in the fixtures look alike and so nothing there is ever decided by the runner-up. A margin guards against two enrolled People of one Brand being told apart by the third decimal of a cosine, and a set that does not contain that case cannot measure the guard against it. 0.05 is a guard at the size of run-to-run noise, chosen and not measured. The script prints the flat table rather than implying a measurement it did not make.

**A false Match is the failure that matters.** Not a wrong number in a log: the wrong person's face left sharp in a published post. So the sweep fails the run on a single false Match and merely reports a missed one.

### What re-calibration needs

- Real enrolled People, photographed the way the operator actually photographs them. The fixtures are studio and launch-pad photographs of astronauts; a phone snapshot at an event is a harder problem, and the honest expectation is that same-person scores fall.
- At least one pair of People who resemble each other, or the margin stays a guess.
- Re-run `pnpm test:match`, move the constants in `src/people.ts`, and edit the table above. Both constants are exported and documented at their definition, so there is one place to change.

## Consequences

- **A stored Face Print carries no model tag.** `/embed` does not say which network produced it, and meco does not invent one — a tag meco wrote would be a claim about the service's internals that meco cannot check. The consequence is operational and unavoidable: **if the recognition model ever changes, every stored Face Print must be recomputed**, because a print from one network is meaningless against a print from another. There is no migration that reads the old prints; the Reference Photos are still in the store, so re-enrolment is a re-embed of what is already there, and it is the only path. This is also the real cost of Decision 1's "the replacement is a file".
- **The threshold and the margin are two exported constants**, `MATCH_THRESHOLD` and `MATCH_MARGIN` in `src/people.ts`, read by the service and by the sweep. Nothing else may hold a copy.
- **The sweep does not load a model.** It reads `fixtures/faces/face-prints.json`, written by meco-faces' own ONNX path and kept current by `pnpm test:embed`, which re-embeds every fixture face and fails if the file has drifted. That is what lets a calibration live in meco while the embedder lives in the other package (ADR-0002), and what stops a stale file from producing a beautiful table about numbers nobody computes any more.
- **`persons` narrows at the end, not at the start.** A Crop naming Person ids is still compared against the Brand's whole gallery, and a winner nobody asked for is refused rather than the request being answered from a subset. Comparing against a subset would hand a face that really belongs to an unlisted Person to whichever listed Person scored highest.
- **Matching never crosses a Brand.** The Face Prints come from a listing of one Brand's prefix, so isolation is a property of which keys were read rather than a filter applied after. Naming another Brand's Person is refused by name, not silently ignored.
- **A Crop with no Brand names nobody**, and then Face Blur hides every face — which is exactly what a Crop did before People existed.
- **The Annotation stays free of names.** It is cached under the hash of the image bytes and which faces are Matches depends on the Brand that asked, so a name written into it would hand the next Brand somebody else's answer. `find_subjects` reports Matches beside the Annotation, keyed by region id, and never inside it.
