# ADR-0001 — Analytic solver over search-based crop

Status: **accepted, 4 Sep 2026**. Research: [`../research/subject-aware-cropping.md`](../research/subject-aware-cropping.md) Q6. Plan: [`../plans/faces-and-subject-aware-crop.md`](../plans/faces-and-subject-aware-crop.md).

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
