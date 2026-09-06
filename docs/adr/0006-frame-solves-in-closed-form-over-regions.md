# ADR-0006 — frame solves the crop window in closed form, over Regions and never over pixels

Status: **accepted, 6 Sep 2026**. Supersedes [ADR-0001](0001-analytic-solver-over-search-based-crop.md)'s producer ladder; ADR-0001 stays as the history of how the solver was arrived at. Parent: [Module: frame (#82)](https://github.com/timschoch/meco/issues/82), under the modular rebuild map [Wayfinder: the modular rebuild of meco #60](https://github.com/timschoch/meco/issues/60). Shapes from [What belongs in an Annotation #69](https://github.com/timschoch/meco/issues/69) and [What belongs in a FramingRequest #70](https://github.com/timschoch/meco/issues/70), spelled out in [`../specs/contracts.md`](../specs/contracts.md). Vocabulary: [`CONTEXT.md`, frame](../../CONTEXT.md#frame).

## Context

ADR-0001 chose a closed-form solver over a search, on two arguments: a Subject Area can be satisfied exactly rather than approximately, and the arithmetic is testable without an image. Both held. But in the prototype the solver merely _chose_ not to touch pixels — `src/crop.ts` sat beside it holding sharp, read a saliency point out of the image, and handed it down as one more Subject Box.

The rebuild moves the seam. frame is given an Annotation, the Matches for one Brand and a FramingRequest, and **no pixel crosses that seam at all**. Everything that ever looked at an image did so in `models`, before frame was called.

That changes what the decision even is. Two further things arrived with the seam and have no answer in ADR-0001: a Template now declares Occlusion Zones that the Subject must avoid, and `pinTo` arrived as an ordered list the caller supplies rather than a ladder frame hard-codes.

## Decision

**frame is one pure function over data. A search is not rejected here; it is unavailable.**

- **Closed form is the only option the seam admits.** A search scores candidate windows against the picture, and frame cannot see the picture. This is a stronger claim than ADR-0001's and it replaces it: that ADR weighed two live options, and after the seam moved there is one.
- **`pinTo` is the caller's ladder, walked in order** — `match`, then `face`, then `kart`, or whatever subset and order the caller sent. The first entry that composes a Subject wins. frame's own last resorts sit underneath and are not in the caller's vocabulary: the Crop Anchor the request named, then the centre.
- **Saliency is gone.** No `strategy`, no `attention` pin, no caller-supplied point. sharp's attention point is not a catalogue Model ([The three models carry over, on measurement #68](https://github.com/timschoch/meco/issues/68)), and an input point would be a producer smuggled in through the request. If a saliency Model ever earns a place it arrives as a Region Kind from `models`, which is the seam for it.
- **Subjects are composed from Region _Kind_, never from a Label.** The kart Subject seeds on the largest `vehicle` Region and unions in every Region overlapping it by more than 0.25 of the smaller box, falling back to the largest `person` Region. The prototype named the COCO word `motorbike`; naming a Kind is what makes ADR-0002's promise — that swapping the detector moves nothing in meco — actually true.
- **An Occlusion Zone aims the window. It never sizes it.** The Free Area, the largest zone-free rectangle of the Image Slot, is what the Subject is aimed at, and the Eye Line aims at _its_ upper Golden Line rather than the frame's. A declared Subject Area still does both jobs, sizing the window and supplying the aim point.
- **frame never fails on geometry.** A Source Image too small to fill its Subject Area gets the best window there is, with `subjectAreaSatisfied: false` and `subjectAreaShortfall` saying by how much. The prototype threw here, which is the one place it broke its own rule that the ladder degrades rather than refuses.
- **The producer priority table is deleted.** With `pinTo` deciding which rung answers, cross-producer ranking has nothing left to decide. Three tiers remain _inside_ the answering rung — the Leading Subject, a matched non-leading face, every other face — and that ordering is only ever consulted by the drop rung.

## Why occlusion aims but does not size

This was designed the other way first, folding the Free Area into the same zoom term as the Subject Area so both shared one code path. That is wrong, and the reason is worth keeping: **no zoom clears an overlay.** Zooming in makes the Subject larger in the frame and so _more_ likely to touch a caption band; zooming out is impossible past the cover window. The only motion that clears a zone is sliding the Subject, which is an aim.

Measured against the three real YuNet detections in [`fixtures/faces/detected.json`](../../fixtures/faces/detected.json) (astronaut-portrait 1280x1600, artemis-2-crew, soyuz-crew) at 1:1, 4:5 and 9:16, with and without a full-width caption band from y 0.76:

|                                          | Eye Line lands at    | leading face clear of the band |
| ---------------------------------------- | -------------------- | ------------------------------ |
| no Occlusion Zone                        | **38.2 %**, all nine | n/a                            |
| caption band, window with vertical slack | **29.0 %**           | yes, 6 of 6                    |
| caption band, window already full height | 38.2 %, unmoved      | yes                            |

**Amendment, 6 Sep 2026, from [#107](https://github.com/timschoch/meco/issues/107).** The table above was measured against the design prototype. Against the shipped code the second row is **7 of 9**, not 6: the headroom zoom of [#103](https://github.com/timschoch/meco/issues/103) tightens `artemis-2-crew.jpg` at 1:1 far enough to buy that row the vertical slack it needs, and only its 4:5 and 9:16 windows are still against the bottom edge with nowhere lower to aim. The leading face is clear of the band on all nine. 29.0 % is unchanged, and so is every conclusion drawn from it. `packages/frame/tests/occlusion.test.ts` carries the row list, and the numbers here are the prototype's.

29.0 % is `0.382 x 0.76`, the upper Golden Line of the Free Area. So the composition rule is not switched off by an overlay, it is re-expressed inside what the overlay leaves. The rows that did not move are the case ADR-0001 already names: a cover window touches the Source Image on one axis by construction, and an axis with no slack is fixed by the shape rather than by the solver.

## What ADR-0001 keeps

- **The eye-line amendment of 5 Sep 2026 carries unchanged**, including its floor on the leading face alone rather than on the union of every Subject. Re-derived here from the same fixture: on `soyuz-crew.jpg`, with the middle face leading, the union floor puts the eyes at **34.2 %** against the 38.2 % the rule asks for, and the leading-face floor reaches 38.2 % at a zoom of 1.12. Those are the amendment's own numbers, reproduced.
- **The fallback ladder** — zoom out, relax, drop, clip — and its rule that every rung is reported.
- **The Subject Area is satisfied exactly or the miss is reported**, never approximated.
- **A new detector adds a composer, not a scoring term.** No weights to retune.

## Consequences

- **frame's dependency list is `@meco/contracts` and nothing else.** No image library, no network, no store, in the module or in its tests.
- **frame is correct only if `models` keeps its side of the Region Kind bargain.** Measured: composing on COCO's eight vehicle classes instead of the Label `motorbike` reproduces the recorded kart Subject on 5 of the 6 committed karting fixtures in [`fixtures/karts/objects.json`](../../fixtures/karts/objects.json), and the one it breaks is `on-track-dark-visor.jpg`, whose own note reads "this is the photograph the whole feature exists for". A spurious `boat` box at score 0.506 spanning 0.92 x 0.30 outsizes the correct `motorbike` at 0.294, and the Subject goes from the kart and its driver to most of the frame. A score floor cannot fix it: the wrong box scores higher than the right one. So `kind: vehicle` means **a road vehicle a person rides or drives** — `motorbike, bicycle, car, bus, truck` — and `boat`, `aeroplane` and `train` map to no Kind in v1. That constraint lives in `models` and belongs in its adapter conformance ([Module: models #83](https://github.com/timschoch/meco/issues/83)); frame carries no special case for it.
- **The 0.25 overlap constant is inherited, not re-derived.** It was measured on 32 on-track karting photographs in the prototype's research, overlap-of-the-smaller-box rather than IoU because a driver's box is a fraction of the kart's, and it took that set from 29 usable to 31 with nothing regressed. frame's fixtures are recordings from Models nobody has re-run, so a ticket under [Module: frame #82](https://github.com/timschoch/meco/issues/82) re-records them once the new adapters exist and either re-affirms 0.25 or re-measures it.
- **frame filters Matches to the request's Brand.** `identify` already guarantees it, so this is belt and braces — but the Brand wall is a privacy boundary, and a wrong Match leaking across it would show up as a stranger's face leading the composition of somebody else's Crop. One line, in the module that would be blamed.
- **One guard that is not geometry, and it lives in contracts.** The Free Area sweep is polynomial in the Occlusion Zone count, and an unbounded list has no best-effort answer to give — only work to refuse. That is a different failure from a geometric shortfall, which is always answered. So `FramingRequest.occlusion` is capped at 16 rectangles in the contracts schema and the gateway refuses a longer list with a `400`, which is the right place for it: at the edge, before any module runs. frame keeps a `RangeError` above the same bound as a defensive invariant, never as the wall.
- **The solver can still be wrong in a new way**: a window that satisfies the arithmetic and looks bad. The mitigation is unchanged and now richer — the Framing reports which rung ran, which Region led, what was dropped, and whether the Subject Area and the Occlusion Zones were honoured.

## Amendment, 6 September 2026 — the recordings and the constant (#109)

Three of the consequences above were written against fixtures nobody could re-run. `packages/frame/tests/record.ts` now re-records all nine through the shipped Catalogue — yunet@1, dfine@1, edgeface@1 at the Decode Bound — and what it found:

- **Every inherited box reproduced.** All 55 boxes across the nine photographs come back within 4.9·10⁻⁵ of the prototype's, scores within 4.8·10⁻⁵ — the rounding error of the four decimals those recordings were written with, so the numbers are the same numbers. Nothing frame asserts about geometry moved.
- **`kind: vehicle` holds.** `on-track-dark-visor.jpg` draws three `motorbike` Regions and no `boat`, so the seed is the correct kart at 0.294. The bargain the bullet above names is kept by the shipped adapter.
- **0.25 stands, measured — as a band, not a point.** Sweeping the overlap threshold over the six karting recordings, every value in **0.156 to 0.271** composes all six of the human-verified Subjects and no value outside it composes more than five. 0.25 is inside that band with room on both sides. The measurement cannot rank points inside it: those Subjects are themselves 0.25 unions, so 0.20 scores identically. What is no longer inherited is where the rule stops working; separating 0.20 from 0.25 would need photographs whose accepted framing was decided independently of the rule.
- **The kart rung joins `person` and `vehicle` Regions only.** A recording of the whole Catalogue carries faces on a karting photograph, and the rung used to join any overlapping Region — which would let a spectator's face carry the union into the crowd where their body did not. The Kinds are now named in `lib/kart.ts`. On these six it changes no Subject Box and no band edge: it is a hazard closed, not a defect fixed.
- **`DEFAULT_PIN_TO` becomes `["match", "kart", "face"]`, and the kart rung requires a vehicle.** The shipped YuNet finds the driver's head through a visor — 0.6488 on `on-track-rear-helmet.jpg`, 0.8080 on `on-track-visor-open.jpg` — so with `face` first a karting photograph became a visor close-up and lost the livery it was taken for. Ordering by how specific the answer is fixes that, but only once the rung stops seeding on the largest `person` when no vehicle is found: measured, the bare reorder framed a body on five of the nine recordings, `astronaut-portrait.jpg` among them. So the `person` seed is deleted. No vehicle, no kart — the rung declines and the ladder walks past it to `face`. A driver can no longer be framed without their kart by this rung; a rung that answers a photograph it is not about was the worse failure.
