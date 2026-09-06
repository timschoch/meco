# Spec: the frame module

Parent: [Module: frame (#82)](https://github.com/timschoch/meco/issues/82). Reasons: [ADR-0006](../adr/0006-frame-solves-in-closed-form-over-regions.md), amending [ADR-0001](../adr/0001-analytic-solver-over-search-based-crop.md). Shapes: [`contracts.md`](contracts.md). Vocabulary: [`CONTEXT.md`, frame](../../CONTEXT.md#frame). Package layout: [`packages/README.md`](../../packages/README.md).

## Problem statement

A Crop has to keep the right thing in frame at any Placement, on a photograph nobody has looked at. The inputs are an analysis of the bytes, the names meco could put to the faces in them, and what this one output needs. The answer is a rectangle. Everything hard about it is arithmetic, and nothing about it needs a pixel — so the module that decides it should not be able to reach one.

## Solution

One package, `@meco/frame`, whose only dependency is `@meco/contracts`. It exports one function that turns an Annotation, the Matches and a FramingRequest into a Crop Window with its reasons attached, one that does the same over every Variant a Template offers and answers the one that keeps the Subject clearest, and one helper that maps a Region into the frame that window cuts.

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
12. As a Template author with two layouts, I want frame to frame both and pick the one that keeps the Subject out from under the type, so that a Subject a full-height column cannot move gets a caption that moves instead ([#228](https://github.com/timschoch/meco/issues/228)).
13. As a caller, I want to be told when the window is smaller than the target and by how much, so that an upscaled Render is a number I can act on and not a soft picture I discover.

## Implementation decisions

### The seam

```ts
// packages/frame/index.ts
export function frameCrop(input: FrameInput): Framing;
export function frameVariants(input: VariantsInput): Framing; // frameCrop over every Variant; the winner, naming its `variant`
export function projectIntoFrame(framing: Framing, box: Box): Box;

export interface FrameInput {
  annotation: Annotation; // source size and Regions, from contracts
  matches?: Match[]; // this Brand's Matches for those Regions
  request: FramingRequest; // what this one output needs
}

export interface VariantRequest {
  variant?: string; // the Variant's name; unnamed for a Template that lays out one way, and for a Crop
  request: FramingRequest;
}
export interface VariantsInput {
  annotation: Annotation;
  matches?: Match[];
  variants: readonly VariantRequest[]; // most preferred first, never empty
}

/** The rectangle to cut, in whole Source Image pixels. Not a `Box`. */
export interface CropWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResolvedBy = "match" | "face" | "kart" | "anchor" | "center";
export type FallbackRung = "zoom-out" | "relax" | "drop" | "clip";

export interface Framing {
  window: CropWindow; // whole Source Image pixels
  windowFraction: Box; // the same window in source fractions
  variant?: string; // the Variant this window was framed for; absent on one layout and on a Crop
  scale: number; // target over window on the constrained axis: what compose resamples by
  lowResolution?: true; // exactly when `scale` is above 1
  resolvedBy: ResolvedBy;
  leadRegionId?: string; // absent when resolved by anchor or center
  subject?: Box; // the composed Subject, source fractions; absent when nothing was composed
  keptRegionIds: string[]; // what survived the ladder, in tier order: the leader, matched non-leaders, the rest, each group by Region id
  droppedRegionIds: string[]; // what the drop rung sacrificed, the same order, the two a partition
  satisfied: boolean;
  fallback?: FallbackRung;
  subjectAreaSatisfied?: boolean; // only when the request named one
  subjectAreaShortfall?: number; // a size ratio: 1 when the picture was big enough, the factor short otherwise
  occlusionClear?: boolean; // only when `occlusion` was non-empty and a Subject was composed
}

export const PHI_LINES: readonly [number, number]; // 1 - 1/φ, 1/φ
export const MAX_OCCLUSION_ZONES: 16;
```

`frameCrop` is the whole module. Subject composition, the ladder, the Golden Lines, the Eye Line, the Free Area and the fallback rungs all sit behind it. The prototype exported `faceSubjectBoxes` and `kartSubjectBox` so a test could reach them; a pure function whose inputs are already plain data does not need that, and the tests cross the same seam as every other caller.

`frameVariants` is `frameCrop` over every Variant a Template offers, each on its own FramingRequest, answering the Framing that scores best with the Variant's name on it. The score, in the order it is read: `occlusionClear` (true first), `satisfied` (true first), the larger Free Area of the request, the smaller `subjectAreaShortfall`, then the Template's own order — an absent `occlusionClear` counts as clear, since it is absent when the Variant declares no zone or when nothing was composed on any of them, and ties within `1e-9` are ties, because two mirrored layouts leave Free Areas equal by construction and arrive at them by different sums. `occlusionClear` leads `satisfied` on a measurement (#228, production Call `e0466f34`): a 3:2 photograph into a story is a full-height column, so on the race photograph every Variant clips (a 411 px Subject in a 300 px window), leaves the same Free Area and the same shortfall, and whether the karts sit under the type is the one number that separates a caption at the top from one at the bottom. The gateway calls `frameVariants` for every Output-producing Call; a Crop and a Template that lays out one way are the one-candidate case, unnamed, whose Framing carries no `variant`. An empty list is a `RangeError`: there is nothing to answer with.

`scale` is on every Framing: the target over the window on the constrained axis, the larger of the two axes' ratios, which differ only by the window's whole-pixel rounding. Above 1 the picture is upscaled and `lowResolution: true` says so beside it; the race photograph's 300 px column into a 1080 px story reads 3.6.

`projectIntoFrame` maps a source-fraction `Box` into output-frame fractions given a Framing. It is a small implementation with one caller, the gateway, which uses it to say which faces landed where in the finished frame for the call record that `records` keeps and `webui` shows. `redact` blurs on the source and `compose` takes the window as a plain `Box`, so neither needs it. It lives here because frame owns what the window means; a division re-derived elsewhere is another chance to round it differently.

`CropWindow` is deliberately not a contracts `Box`. A `Box` is fractions; this is pixels. A type that looked like a `Box` and was not one would be the `w`/`h` mistake of ADR-0002 in a new costume.

**`subjectAreaSatisfied` and `subjectAreaShortfall` measure two different things, and disagree on purpose.** Satisfaction is containment, measured on the window **actually cut** rather than the one the area first asked for. The shortfall is a ratio of sizes: 1 whenever the Source Image was big enough to fill the area, the factor it fell short by otherwise. So an area missed for any reason other than size — a window the picture's own edge pushed off it, or a Subject the drop rung sacrificed — reports `subjectAreaSatisfied: false` at a shortfall of 1. A sacrifice is a miss whatever the window then holds: the area asked for the Subject the rung composed, and a Subject given up is no longer part of it. The anchor and the centre compose no Subject, so an area declared with either of them answering reports the same pair and leaves the placement alone: nothing was composed, so nothing filled the area, and no size fell short. Decided on [#82](https://github.com/timschoch/meco/issues/82), shipped in [#106](https://github.com/timschoch/meco/issues/106).

### The interface beyond the signature

- **Pure.** No clock, no random, no I/O. The same input gives byte-identical output.
- **The source size comes from the Annotation** (`width`, `height`, after EXIF orientation). frame takes no size argument, so the two can never disagree.
- **frame throws on nothing that is geometry.** Every geometric shortfall is answered with the best window there is and a flag saying what was missed.
- **The occlusion cap is the contracts schema's wall, not frame's.** `FramingRequest.occlusion` is `z.array(Box).max(16)`, so the gateway refuses a longer list with a `400` and frame never sees one. frame keeps a `RangeError` above `MAX_OCCLUSION_ZONES` as a defensive invariant, because the Free Area sweep is polynomial in the zone count and an unbounded list has no best-effort answer to give, only work to refuse. Decided on [contracts: FramingRequest and Match schemas with defaults #93](https://github.com/timschoch/meco/issues/93).
- **`window` is whole pixels, inside the Source Image, and within one pixel of the target aspect.**
- **Matches are filtered to `request.brand`, and to a Region this Annotation holds.** `identify` guarantees the Brand; frame checks anyway, because a Match crossing the Brand wall would show as a stranger leading somebody else's Crop. A Match naming no Region in the picture has no box to frame, so it is ignored, which is also what leaves the leader's own Region certain to exist.

### Composing the Subject

`pinTo` is walked in order. The first entry that composes a Subject wins and decides `resolvedBy`.

| `pinTo` entry | Composes                                                                                                                                                                                | Leading Subject                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `match`       | the face Regions, when at least one has a face Match; failing that the kart of a number Match, unioned by the `kart` rule around the `vehicle` identify named                            | the face Match with the highest `similarity`, or that `vehicle` |
| `face`        | the face Regions, when there are any                                                                                                                                                    | the largest face box                     |
| `kart`        | largest `vehicle` Region ∪ every `person` or `vehicle` Region overlapping it > 0.25 of the smaller box. No `vehicle` Region, no Subject: the rung declines and the ladder walks past it | the composed union, which is one Subject |

Nothing composed → the Crop Anchor named in the request → the centre. `resolvedBy` is `anchor` or `center`, and `leadRegionId` and `subject` are both absent: no Region led and no Subject was composed. A window standing in for the Subject it does not have would be held by every rung of the fallback ladder without meaning it, and the point the anchor stands at is not a `Box`, whose sides are above zero. Decided on [#82](https://github.com/timschoch/meco/issues/82), shipped in [#101](https://github.com/timschoch/meco/issues/101).

**A face Match leads ahead of a number Match** ([ADR-0015](../adr/0015-a-race-number-is-a-second-match-rule.md), Decision 4). Not a ranking of evidence but of compositions: a face Subject is the face box, which the Eye Line was calibrated on; a number Subject is the kart union, which nothing here was calibrated on. The number Match answers where the face rule is silent, which is a driver in a crash helmet — the case the rule exists for. Among number Matches the tie-break is the lowest Region id and there is no other rule: every one of them is a read digit found on the Brand's own list, equally, and the reader's own score would rank how clear the digits were rather than how much the photograph is about that kart.

A leading number Match composes the kart around **its own** `vehicle`, not the largest one. On the recording of `kart-grid-24.jpg` the largest `vehicle` box covers 0.5527 of the frame against the #24 kart's 0.1275, because it is a detection over the whole row: seeding by size would frame the grid instead of the kart identify named.

**`persons` narrows who may lead and nothing else.** With `persons` given, only Matches whose `personId` is on the list are candidates to lead. A photograph that matched somebody, but nobody on the list, **falls through to the next `pinTo` entry** rather than leading on the unlisted Match: a caller who named `persons` asked for those people, and choosing the window around a different named person would leak who else is in the picture. A Match the list excluded is still a kept face at its tier on this rung, because `persons` decides who leads and not who is kept.

Ties: the highest `similarity`, then the lowest `regionId`. `similarity` and not the largest face, because it says who meco is surest of and does not move as people walk about — largest would let the framing wobble across a burst of photographs. "Lowest" is read off the id's own number, `<kind>-<n>` from the Region schema, and never off the position in `annotation.regions`: `assignRegionIds` does hand the Regions over in id order, but `Annotation.parse` promises nothing about the order they arrive in.

Three tiers exist inside the answering rung, and only the drop rung consults them: the Leading Subject, a matched non-leading Region, every other kept Region. The prototype's cross-producer `PRIORITY` table is gone; with `pinTo` deciding which rung answers, it had nothing left to decide.

**The tiers are the order of `keptRegionIds`**, cheapest last, so the drop rung sacrifices from the end and no field carries them that a caller could pair with another rung's Subject. **The same order on every rung**, applied by the ladder rather than by a rung, so "cheapest last" is one promise instead of one per rung. Within a group the order is Region id — the id's own number, `<kind>-<n>` from the Region schema, never the position in `annotation.regions`, which `Annotation.parse` does not promise.

A Match keeps its middle tier whichever rung answered: the `face` rung answers a request whose Matches `persons` all excluded, and those faces are still the ones worth keeping. `kart` keeps `person` and `vehicle` Regions, which no Match names, so its middle tier is always empty. Shipped in [#104](https://github.com/timschoch/meco/issues/104).

A `face` Subject is the face box alone. frame never grows it to the `person` Region containing it: the Eye Line criterion was measured on face boxes, and framing on a body is a different composition with no measurement behind it.

### Placing the window

1. **Size.** The cover window is the largest window of the target shape that fits the Source Image. A declared `subjectArea` sizes the window so the Subject fills it; failing that, an Eye Line sizes it so the eyes can reach the upper Golden Line, floored on the Leading Subject's own box. Never below the cover window. A window a Subject Area sized is rounded **up**, because `subjectArea` fixes the smallest window that holds the Subject inside it and the containment slack below is already spent on the origin's own rounding; its longer axis is derived from its shorter one, so that rounding is divided by the aspect rather than multiplied by it.
2. **Aim.** With a `subjectArea`, the Subject aims at its centre. Otherwise the Subject aims at the Golden Line nearest to where it already sat, which moves the photographer's composition as little as possible; with an Eye Line, the eyes aim at the upper Golden Line instead, down the frame only — an Eye Line is a fraction of the Source Image height and says nothing about the other axis, where the Subject keeps its nearest Golden Line.
3. **Free Area.** The largest rectangle of the Image Slot no Occlusion Zone touches, intersected with `subjectArea` when both are given (`subjectArea` wins an empty intersection, and the miss is reported). The aim point is clamped so the Subject lands inside it, and the Eye Line aims at the Free Area's upper Golden Line rather than the frame's. **The Free Area never changes the size.** `occlusionClear` reports the result on the window actually cut, and is absent when the anchor or the centre answered: it says something about a Subject, and those two rungs compose none.
4. **Clamp** to the Source Image, then round to whole pixels.

Containment allows **0.5 px** of slack, because the window is rounded before it is cut and exact containment would report a fallback for a Subject half a pixel out. One rounding, not two: that is the budget the window's origin spends, which is why a window sized by a `subjectArea` rounds up rather than to nearest.

### The fallback ladder

Tried in order, first that holds every kept Subject wins, and the rung is always named:

| Rung       | Does                                                                  |
| ---------- | --------------------------------------------------------------------- |
| —          | the composition first asked for; `satisfied: true`                    |
| `zoom-out` | drop back to the cover window                                         |
| `relax`    | slide the target halfway to the middle of the frame, then all the way |
| `drop`     | sacrifice the cheapest Subject, then the next, by tier                |
| `clip`     | centre on the Subject at the cover window and accept the clipping     |

**What "holds" means: every kept Region's own box inside the window**, with the
0.5 px of slack below — not the composed Subject Box. The two do not coincide:
`person-5` of `paddock-mixed.jpg` sits inside the composed Subject without being
kept, and a predicate on the Subject Box alone is one the drop rung could never
repair, since sacrificing a Region does not move it. Decided on
[#105](https://github.com/timschoch/meco/issues/105).

**The repairs are cumulative, and the sacrifices are counted first.** The first
three rungs are one window each: what was asked for, the cover window at the
same aim, and the cover window at an aim slid halfway to the middle of the frame
and then to it. Each holds at least as much as the one above, so a rung answers
only where the cheaper ones could not. Nothing is sacrificed while any of those
three still holds every kept Subject; once one Subject has been given up, the
three are tried again for whoever is left, and the cheapest of them that holds
them is the window. So a sacrifice buys back the tightest window that works
rather than the widest — which is what keeps a group photograph framed on the
face the Eye Line composed it around instead of centred on nobody.

**A sacrifice names the `drop` rung whichever window bought it back**: the
ladder reports what it gave up, and a Subject outranks a pixel.

The Leading Subject is never sacrificed, so the surviving set never empties and
`clip` is what answers a Subject no window of that shape can hold. `clip` gives
up containment and nothing else: it sacrifices nobody, so `droppedRegionIds` is
empty and every kept Region is still reported as kept, at `satisfied: false`.

`satisfied` is true exactly when no rung ran, and `fallback` is absent exactly
then. `keptRegionIds` and `droppedRegionIds` partition the Regions the answering
rung composed on, both in tier order, so concatenating them gives back what the
rung kept before the ladder ran. Shipped in
[#108](https://github.com/timschoch/meco/issues/108).

### Tie-breaking, all of it

Written down because determinism is a promise the tests check: the Golden Line tie goes to the upper-left line; the Match tie goes to the lowest `regionId`; the Free Area tie goes to the largest area, then the rectangle nearest the frame centre, then lowest `y`, then lowest `x`; the Variant tie goes to the Template's earlier one.

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

- **Fixtures are recordings of the shipped Catalogue.** `packages/frame/tests/record.ts` POSTs the nine photographs under [`fixtures/`](../../fixtures/) to a running `models` container and writes the Annotations it gets back to `packages/frame/tests/fixtures/`. It refuses to write anything whose `producedBy` is not exactly what `GET /models` listed, so a recording always names the Models that made it. Each fixture is `Annotation.parse`d by the contracts schema inside the test, so a fixture that drifts from the contract fails frame's suite rather than rotting quietly. Re-run it whenever an adapter version moves.
- **Every assertion is a number read back off the window**: the Eye Line within 2 % of the upper Golden Line at 1:1, 4:5 and 9:16; the window on the picture; every kept Subject contained or a rung named; the Subject clear of the Occlusion Zones or `occlusionClear: false`; the composed kart Subject equal to the recording.
- **Only axes with slack are asserted.** A cover window touches the Source Image on one axis by construction, and an axis with no slack is fixed by the shape, not by the solver.
- **Property tests** for the promises the signature does not carry: determinism over repeated calls, whole-pixel windows, containment in the Source Image, aspect within one pixel, and every tie-break rule above.
- **Every check ships with the mutation that turns it red**, named in its ticket.

## Out of scope

- Anything that touches, fetches, decodes or writes a pixel.
- Saliency in any form, including a caller-supplied point. ADR-0006 says why and where it would arrive if it ever earned a place.
- Growing a face Subject to the body Region containing it. Wanted eventually, no measurement yet.
- Non-rectangular Occlusion Zones. A Template that needs one lists several rectangles ([What belongs in a FramingRequest #70](https://github.com/timschoch/meco/issues/70)).
- Choosing between two karts in one photograph. The prototype recorded that its answer is not stable across resolutions (`on-track-dark-visor.jpg`, [Which kart the union rule returns moves with the resolution #42](https://github.com/timschoch/meco/issues/42)); both answers are a kart with a driver on it, and nothing here makes it worse.
