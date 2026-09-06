# ADR-0001 — Analytic solver over search-based crop

Status: **accepted, 4 Sep 2026**; amended 5 Sep 2026, see below. Research: [`../research/subject-aware-cropping.md`](../research/subject-aware-cropping.md) Q6. Plan: [`../plans/faces-and-subject-aware-crop.md`](../plans/faces-and-subject-aware-crop.md).

## Context

A Crop has to keep the Subject in frame at any Placement. Two families answer that:

- **Search.** Score candidate windows and keep the best. smartcrop.js slides a window with a tuned scorer; libvips `smartcrop` takes the argmax of a 32×32 saliency map. A known region is steered by adding a `boost` term to the score.
- **Solve.** Turn every framing input into a Subject Box, derive the anchor point, and compute the window in closed form.

meco needs more producers over time — saliency now, faces and matched People next, a kart and a driver's head after that — and Templates will declare a Subject Area the Crop must satisfy exactly.

## Decision

Frame every Crop with a closed-form solver: `solveCrop` in `src/crop-solver.ts`.

- One anchor point from the Subject Boxes, a target position in the frame (the nearest golden line by default), one clamp to the image.
- Failure to hold every `keep` Subject is repaired by a fixed ladder — zoom out, relax the target, drop the lowest priority Subject, clip — and the rung taken is reported.
- The module imports no image library. Producers that must touch pixels live in `src/crop.ts` and hand the solver Subject Boxes.

## Consequences

- **Testable without an image.** `pnpm test:crop` asserts golden-line placement and each fallback as arithmetic. A scorer would need fixtures and a tolerance instead.
- **A Subject Area is satisfied exactly**, not approximately. A search can only get close.
- **A new detector adds a producer, not a scoring term.** No weights to retune when faces arrive.
- **No boost mechanism.** Boosting exists to make a known region win a search; nothing here searches.
- **Saliency becomes an input, not the method.** sharp's attention point enters as one Subject Box among others, and its known weaknesses — a 32×32 argmax, a skin heuristic biased against dark skin — are outranked as soon as a face producer exists rather than being the whole answer.
- **The solver can be wrong in a new way**: a window that satisfies the arithmetic and still looks bad. Mitigation is the reported `resolvedBy` and `fallback`, which say which producer and which rung produced a given framing.

## Amendment, 5 Sep 2026 — the headroom zoom is floored on the leading face, not on every Subject

The eye-line rule tightens the window so the eyes can reach the upper golden line, and refuses to tighten past the point where the Subject would no longer fit. "The Subject" was read as the union of every `keep` Subject Box.

In a group photograph that reading switches the rule off. The faces stand wider apart than any window that would give one of them headroom, so the floor exceeds the cover window, the zoom clamps to 1, and the eye line stays wherever the photographer left it — however far the fallback ladder then goes on to sacrifice the other faces. Measured on `fixtures/faces/soyuz-crew.jpg` at 1:1, 4:5 and 9:16: the matched Person's eyes landed at 34.2 % against the 38.2 % the rule asks for, with the ladder already reporting `drop`.

The floor is now the **leading** Subject Box alone — the one the eyes were read off. Containment of the others is the ladder's question, asked after, and folding it into the zoom answered it twice.

- **Why it had to change here.** Person matching exists so that a Crop can be framed on one named individual in a crowd, and the eye line is what "framed on" means. The rule could not do its job in the only situation the feature is for.
- **It changes group Crops that match nobody, too.** Any photograph with several faces now tightens where it previously did not. That is the same rule applied consistently rather than a second rule for Persons: the leading face was always what the eye line was read off, and the old floor was about a different Subject from the one being placed. `pnpm test:crop` covers both, and the existing group assertions still hold.
- **A tighter window can still lose a face**, and says so. Nothing about the ladder or its reporting changed.

## Amendment, 5 Sep 2026 — the fallback ladder, written down once

Issue #23 asked whether a bare Crop — no face, no `anchor`, no `strategy` — should frame itself on the busiest region or stay on `centre`. **The decision is `centre`: saliency stays behind an explicit request.** It is recorded here rather than only on the issue because the ladder itself had never been written down in one place, and a reader was left to infer it from the producer list.

`subjectBoxes` in `src/crop.ts` is the ladder. It returns at the first rung that has an answer:

| Rung                                                  | Answers when                                                  | Skipped when                             |
| ----------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------- |
| **face** — Matches lead if `pinTo` is `person`        | any face was detected                                         | `pinTo` is `attention` or `kart`         |
| **kart** — `kartSubjectBox` over the detected objects | any `motorbike` or `person` object was detected               | `pinTo` is `attention`                   |
| **saliency** — sharp's attention point                | `strategy` was given, **or** `pinTo` is `attention` or `kart` | otherwise — including every bare request |
| **anchor** — one of the nine Crop Anchors             | `anchor` was given                                            | otherwise                                |
| **centre**                                            | always                                                        | never                                    |

**So a bare request resolves by `centre`**, which is what #23 decided and what `pnpm test:http` pins. `pinTo` defaults to `person`, no `strategy` is set, and a photograph with no faces and no objects falls past face, kart and saliency to the bottom.

**Why not ungate saliency.** Every Crop that passes neither an anchor nor a strategy would change picture, and stored Crops are content-addressed, so their keys and URLs would move too — callers who asked for nothing would get something different. Against that the upside is small, and the Consequences above already say why: sharp's attention point is a 32×32 argmax with a skin heuristic biased against dark skin. The case where it would have helped most, a photograph of people, is now answered better by the face producer. What is left is landscapes and objects, where `centre` is defensible and a caller who knows better can say `strategy: "attention"`. Reversing this is one line in `subjectBoxes` plus the probe check; the thing to watch is Crops of photographs with no people landing on empty background.

**Two things the table is easy to misread.**

`pinTo: "kart"` **selects saliency by itself** when no kart is found. Saliency is opt-in for a bare request, not opt-in everywhere: the research measured it framing the on-track photographs the detector misses, so falling past it to a Crop Anchor would throw away the rung that covers exactly that case.

**Rung order is not priority order.** `PRIORITY` in `src/crop.ts` ranks Subject Boxes _inside_ the solver — `person` 50, `kart` 45, `face` 40, `saliency` 30, `anchor` 20, `centre` 10 — and `kart` outranks `face` there. The ladder is the separate question of which producer gets to answer at all, and faces are asked first. A photograph with both a face and a kart is framed on the face; the priority number only matters when one producer yields several boxes at once.
