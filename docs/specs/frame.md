# Spec: the frame module

Parent: [Module: frame (#82)](https://github.com/timschoch/meco/issues/82). Reasons: [ADR-0006](../adr/0006-frame-solves-in-closed-form-over-regions.md), amending [ADR-0001](../adr/0001-analytic-solver-over-search-based-crop.md). Shapes: [`contracts.md`](contracts.md). Vocabulary: [`CONTEXT.md`, frame](../../CONTEXT.md#frame). Package layout: [`packages/README.md`](../../packages/README.md).

## Problem statement

A Crop has to keep the right thing in frame at any Placement, on a photograph nobody has looked at. The inputs are an analysis of the bytes, the names meco could put to the faces in them, and what this one output needs. The answer is a rectangle. Everything hard about it is arithmetic, and nothing about it needs a pixel — so the module that decides it should not be able to reach one.

## Solution

One package, `@meco/frame`, whose only dependency is `@meco/contracts`. It exports one function that turns an Annotation, the Matches and a FramingRequest into a Crop Window with its reasons attached, and one helper that maps a Region into the frame that window cuts.

## User stories

1. As the gateway, I want one call that takes what I already have and returns the rectangle to cut, so that framing is never something I assemble from parts.
2. As a Brand with enrolled People, I want a named individual to lead the composition however small their face is, so that the Crop is of the person the photograph was matched for.
3. As a caller with several People enrolled, I want `persons` to narrow who may lead, so that a photograph of two of my People frames the one I asked about.
4. As a karting photographer, I want a kart and its driver framed as one Subject, so that the Crop keeps the livery and the helmet together.
5. As a Template author, I want the Subject kept out of the area my caption covers, so that the text never lands on a face.
6. As a Template author, I want to declare where the Subject must land and be told whether it did, so that a layout that needs a tight head-and-shoulders can trust the Crop or know it cannot.
7. As `redact`, I want to map a face Region into the finished frame, so that I blur the faces that are actually in the picture and no others.
8. As `records`, I want the Framing stored verbatim, so that the webui can show why the Crop looks the way it does.
9. As an agent calling frame alone, I want a window back for any geometry I can express, so that a photograph too small for what I asked still gives me a picture and an honest answer.
10. As a maintainer, I want every claim frame makes to be a number a test can read back with no image, so that the suite runs in milliseconds and says something true.
11. As `models`' author, I want frame to name Region Kinds and never my Labels, so that I can replace a detector without touching another module.

## Implementation decisions

### The seam

```ts
// packages/frame/index.ts
export function frameCrop(input: FrameInput): Framing;
export function projectIntoFrame(framing: Framing, box: Box): Box;

export interface FrameInput {
  annotation: Annotation;      // source size and Regions, from contracts
  matches?: Match[];           // this Brand's Matches for those Regions
  request: FramingRequest;     // what this one output needs
}

/** The rectangle to cut, in whole Source Image pixels. Not a `Box`. */
export interface CropWindow { x: number; y: number; width: number; height: number }

export type ResolvedBy = "match" | "face" | "kart" | "anchor" | "center";
export type FallbackRung = "zoom-out" | "relax" | "drop" | "clip";

export interface Framing {
  window: CropWindow;              // whole Source Image pixels
  windowFraction: Box;             // the same window in source fractions
  resolvedBy: ResolvedBy;
  leadRegionId?: string;           // absent when resolved by anchor or center
  subject: Box;                    // the composed Subject, source fractions
  keptRegionIds: string[];
  droppedRegionIds: string[];
  satisfied: boolean;
  fallback?: FallbackRung;
  subjectAreaSatisfied?: boolean;  // only when the request named one
  subjectAreaShortfall?: number;   // 1 when satisfied, the factor short otherwise
  occlusionClear?: boolean;        // only when `occlusion` was non-empty
}

export const PHI_LINES: readonly [number, number];   // 1 - 1/φ, 1/φ
export const MAX_OCCLUSION_ZONES: 16;
```

`frameCrop` is the whole module. Subject composition, the ladder, the Golden Lines, the Eye Line, the Free Area and the fallback rungs all sit behind it. The prototype exported `faceSubjectBoxes` and `kartSubjectBox` so a test could reach them; a pure function whose inputs are already plain data does not need that, and the tests cross the same seam as every other caller.

`projectIntoFrame` maps a source-fraction `Box` into output-frame fractions given a Framing. It is a small implementation with three callers — `redact` placing a blur ellipse, `compose` checking its overlay, `webui` drawing what happened — and its value is locality, not size: a division re-derived in three modules is three chances to round it differently.

`CropWindow` is deliberately not a contracts `Box`. A `Box` is fractions; this is pixels. A type that looked like a `Box` and was not one would be the `w`/`h` mistake of ADR-0002 in a new costume.

### The interface beyond the signature

- **Pure.** No clock, no random, no I/O. The same input gives byte-identical output.
- **The source size comes from the Annotation** (`width`, `height`, after EXIF orientation). frame takes no size argument, so the two can never disagree.
- **frame throws on nothing that is geometry.** Every geometric shortfall is answered with the best window there is and a flag saying what was missed.
- **The occlusion cap is the contracts schema's wall, not frame's.** `FramingRequest.occlusion` is `z.array(Box).max(16)`, so the gateway refuses a longer list with a `400` and frame never sees one. frame keeps a `RangeError` above `MAX_OCCLUSION_ZONES` as a defensive invariant, because the Free Area sweep is polynomial in the zone count and an unbounded list has no best-effort answer to give, only work to refuse. Decided on [contracts: FramingRequest and Match schemas with defaults #93](https://github.com/timschoch/meco/issues/93).
- **`window` is whole pixels, inside the Source Image, and within one pixel of the target aspect.**
- **Matches are filtered to `request.brand`.** `identify` guarantees it; frame checks anyway, because a Match crossing the Brand wall would show as a stranger leading somebody else's Crop.

### Composing the Subject

`pinTo` is walked in order. The first entry that composes a Subject wins and decides `resolvedBy`.

| `pinTo` entry | Composes | Leading Subject |
|---|---|---|
| `match` | the face Regions, when at least one has a Match | the Match with the highest `similarity` |
| `face` | the face Regions, when there are any | the largest face box |
| `kart` | largest `vehicle` Region ∪ every Region overlapping it > 0.25 of the smaller box; largest `person` Region when there is no vehicle | the composed union, which is one Subject |

Nothing composed → the Crop Anchor named in the request, as a zero-extent Subject placed at its own point → the centre. `resolvedBy` is `anchor` or `center` and `leadRegionId` is absent.

**`persons` narrows who may lead and nothing else.** With `persons` given, only Matches whose `personId` is on the list are candidates to lead. A photograph that matched somebody, but nobody on the list, **falls through to the next `pinTo` entry** rather than leading on the unlisted Match: a caller who named `persons` asked for those people, and choosing the window around a different named person would leak who else is in the picture. Every Match is still a kept Subject at its tier whichever rung answers.

Ties: the highest `similarity`, then the lowest `regionId`. `similarity` and not the largest face, because it says who meco is surest of and does not move as people walk about — largest would let the framing wobble across a burst of photographs.

Three tiers exist inside the answering rung, and only the drop rung consults them: the Leading Subject, a matched non-leading face, every other face. The prototype's cross-producer `PRIORITY` table is gone; with `pinTo` deciding which rung answers, it had nothing left to decide.

A `face` Subject is the face box alone. frame never grows it to the `person` Region containing it: the Eye Line criterion was measured on face boxes, and framing on a body is a different composition with no measurement behind it.

### Placing the window

1. **Size.** The cover window is the largest window of the target shape that fits the Source Image. A declared `subjectArea` sizes the window so the Subject fills it; failing that, an Eye Line sizes it so the eyes can reach the upper Golden Line, floored on the Leading Subject's own box. Never below the cover window.
2. **Aim.** With a `subjectArea`, the Subject aims at its centre. Otherwise the Subject aims at the Golden Line nearest to where it already sat, which moves the photographer's composition as little as possible; with an Eye Line, the eyes aim at the upper Golden Line instead.
3. **Free Area.** The largest rectangle of the Image Slot no Occlusion Zone touches, intersected with `subjectArea` when both are given (`subjectArea` wins an empty intersection, and the miss is reported). The aim point is clamped so the Subject lands inside it, and the Eye Line aims at the Free Area's upper Golden Line rather than the frame's. **The Free Area never changes the size.**
4. **Clamp** to the Source Image, then round to whole pixels.

Containment allows **0.5 px** of slack, because the window is rounded before it is cut and exact containment would report a fallback for a Subject half a pixel out.

### The fallback ladder

Tried in order, first that holds every kept Subject wins, and the rung is always named:

| Rung | Does |
|---|---|
| — | the composition first asked for; `satisfied: true` |
| `zoom-out` | drop back to the cover window |
| `relax` | slide the target halfway to the middle of the frame, then all the way |
| `drop` | sacrifice the cheapest Subject, then the next, by tier |
| `clip` | centre on the Subject at the cover window and accept the clipping |

### Tie-breaking, all of it

Written down because determinism is a promise the tests check: the Golden Line tie goes to the upper-left line; the Match tie goes to the lowest `regionId`; the Free Area tie goes to the largest area, then the rectangle nearest the frame centre, then lowest `y`, then lowest `x`.

### What frame relies on from other modules

- **`models` defines `vehicle`** as a road vehicle a person rides or drives ([`CONTEXT.md`, Region Kind](../../CONTEXT.md#contracts)). Measured consequence and the fixture that proves it: [ADR-0006](../adr/0006-frame-solves-in-closed-form-over-regions.md), Consequences.
- **`contracts` assigns Region ids** by sorted position, so the `regionId` tie-break is stable across runs.
- **`identify` scopes Matches to one Brand.** frame filters anyway.
- **`contracts` caps `occlusion` at 16 rectangles**, so the gateway refuses a longer list before frame is called.

### What crosses to compose

`compose` receives `windowFraction` as a plain contracts `Box`, passed by the gateway, and does the cut and the scale into the Image Slot. It does not import `@meco/frame`, so no frame vocabulary crosses that seam. Two things `compose` must know and cannot read off the type:

- **Scale with `fill`, never `cover`.** `window` is whole pixels, so its aspect matches the target only to within that rounding, at most one pixel on the larger axis. Covering it a second time would re-crop it and undo the framing.
- **The target size is not in the Framing.** It is on the FramingRequest, which the gateway holds. Duplicating it would make two places that could disagree about what was asked for.

## Testing decisions

Vitest, through `packages/frame/index.ts` only, enforced by dependency-cruiser. No image library, no network, no store.

- **Fixtures are recordings of real detections**, converted into contracts `Annotation` JSON under `packages/frame/tests/`: the three faces in [`fixtures/faces/detected.json`](../../fixtures/faces/detected.json) (real YuNet output) and the six karting photographs in [`fixtures/karts/objects.json`](../../fixtures/karts/objects.json) (real D-FINE output, each carrying the Subject the prototype's rule composed). Each fixture is `Annotation.parse`d by the contracts schema inside the test, so a fixture that drifts from the contract fails frame's suite rather than rotting quietly.
- **Every assertion is a number read back off the window**: the Eye Line within 2 % of the upper Golden Line at 1:1, 4:5 and 9:16; the window on the picture; every kept Subject contained or a rung named; the Subject clear of the Occlusion Zones or `occlusionClear: false`; the composed kart Subject equal to the recording.
- **Only axes with slack are asserted.** A cover window touches the Source Image on one axis by construction, and an axis with no slack is fixed by the shape, not by the solver.
- **Property tests** for the promises the signature does not carry: determinism over repeated calls, whole-pixel windows, containment in the Source Image, aspect within one pixel, and every tie-break rule above.
- **Every check ships with the mutation that turns it red**, named in its ticket.

## Out of scope

- Anything that touches, fetches, decodes or writes a pixel.
- Saliency in any form, including a caller-supplied point. ADR-0006 says why and where it would arrive if it ever earned a place.
- Growing a face Subject to the body Region containing it. Wanted eventually, no measurement yet.
- Non-rectangular Occlusion Zones. A Template that needs one lists several rectangles ([What belongs in a FramingRequest #70](https://github.com/timschoch/meco/issues/70)).
- Re-measuring the 0.25 kart overlap constant, which waits on the new adapters and has its own ticket.
- Choosing between two karts in one photograph. The prototype recorded that its answer is not stable across resolutions (`on-track-dark-visor.jpg`, [Which kart the union rule returns moves with the resolution #42](https://github.com/timschoch/meco/issues/42)); both answers are a kart with a driver on it, and nothing here makes it worse.
