# Spec: the redact module

Parent: [Module: redact (#85)](https://github.com/timschoch/meco/issues/85). Settles [Redact v1: blur unknown faces, policy from the request (#67)](https://github.com/timschoch/meco/issues/67). Reasons: [ADR-0008](../adr/0008-redact-blurs-the-source-before-the-cut.md). Vocabulary: [`CONTEXT.md`, redact](../../CONTEXT.md#redact). Contracts: [`contracts.md`](contracts.md). Package layout: [`packages/README.md`](../../packages/README.md).

## Problem statement

A Brand may show the People it enrolled and may not show everybody else who happened to be in the photograph. Something has to turn that sentence into pixels: pick the face Regions with no Match, hide them so no face can be read back, leave every other pixel exactly as it was, and say afterwards which faces it hid so the call record and the webui can show what happened.

The hard part is not the blur. It is keeping the module from acquiring opinions it has no business holding — about who a face is, about how confident the match was, about where the output will be cropped, about what format it will be saved in.

## Solution

One package, `@meco/redact`, one entry point, one function. It takes the decoded Source Image, the Annotation's Regions, this call's Matches and the FramingRequest's redaction policy. It returns the Source Image with every Unknown Face hidden behind a feathered elliptical blur, and one Redaction Record per face it hid.

It works on the **Source Image, before any cut**. `compose` owns cutting `frame`'s window and scaling it into the Image Slot.

## User stories

1. As the gateway, I want one call that hides what must not be shown, so that no module downstream has to know which faces were allowed.
2. As a Brand, I want every face that is not one of my People hidden, so that a photograph of my event can be published without the strangers in it.
3. As a Brand, I want the People I enrolled left untouched at any size and any similarity above identify's threshold, so that matching is worth doing.
4. As a caller, I want `blurUnknownFaces: false` to return the Source Image byte for byte, so that turning the policy off changes nothing.
5. As the webui, I want to be told which Regions were hidden, so that "two of the three faces were hidden" is a sentence I can render against the Annotation.
6. As `records`, I want the Redaction Records keyed by the contracts Region id, so that the record still points at the right face when the Annotation is read back.
7. As a reviewer, I want the choice of which faces to hide separated from the drawing of the mask, so that a change to matching cannot break the pixels and a change to the pixels cannot change the policy.
8. As a future author of plate or sign redaction, I want the mask to need nothing from a Region but its box, so that a Region kind carrying no landmarks is redactable.

## Implementation decisions

### The seam

```ts
// packages/redact/index.ts
export interface RedactRequest {
  readonly image: DecodedImage; // the Source Image, decoded once
  readonly regions: readonly Region[]; // the Annotation's Regions, source fractions
  readonly matches: readonly Match[]; // this call, this Brand
  readonly redaction: Redaction; // { blurUnknownFaces }
}

export interface RedactionRecord {
  readonly regionId: string;
  readonly reason: "unknown-face";
}

export interface RedactResult {
  readonly image: DecodedImage; // same size, same channels
  readonly redactions: readonly RedactionRecord[]; // sorted by regionId
}

export function redact(request: RedactRequest): Promise<RedactResult>;
```

`DecodedImage`, `Region`, `Match` and `Redaction` come from `@meco/contracts`.

No window, no target size, no format, no quality, no Brand, no threshold. The interface is the enforcement: redact cannot form an opinion about framing or identity because it is never told one.

### What redact decides and what it is told

- **No threshold, no gallery, no Person.** A face is unknown when no Match in `matches` carries its `regionId`. A similarity under identify's threshold reaches redact as the absence of a Match. redact never compares a number.
- **An empty `matches` hides every face.** A caller that skipped identify gets full redaction, not none. A face meco cannot name is a face it must not show.
- **An Uncompared Face and a face that is not an Identifiable Face are hidden**, because neither produced a Match. One rule, not three.
- **Only `kind: "face"`.** A `person` Region is a body and is never touched, even when the face above it is unknown; [#67](https://github.com/timschoch/meco/issues/67) said faces only. There is no code path from any other Region kind to a mask.
- **`blurUnknownFaces: false` returns the Source Image unchanged and an empty list.** Not a copy that happens to match — the check is a byte comparison against the input buffer.
- **Nothing about the output.** Which faces survive the crop is `frame`'s arithmetic through `projectIntoFrame`, done by the gateway. redact does not count and does not guess.

### The mask

- **An axis-aligned ellipse inscribed in the Region's box, in Source Image pixels**, feathered over the outer sixth of its radius. Measured: all 40 landmarks over the 8 fixture faces fall inside that ellipse, the worst at normalised radius 0.793 against a feather beginning at 0.833. Tilting the faces improves the cover rather than degrading it — worst radius 0.692 at 10 degrees, 0.540 at 45 — because a rotated face's axis-aligned bounding box grows faster than the face does. So landmarks are unused, and a Region kind that has none is redactable.
- **Gaussian sigma = 0.25 x the face's width in source pixels**, clamped to sharp's legal `[0.3, 1000]`. Measured on the plateau: mean |Laplacian| inside the ellipse falls to 8.3 % of the untouched image at 319 px wide and 5.8 % at 101 px, with the curve flat from k = 0.2 on. Scaled and not fixed, because those two sizes cannot share one sigma.
- **The feather is not decoration.** It is what keeps the mask from announcing itself once `compose` resamples the frame, and the measurement is in [ADR-0008](../adr/0008-redact-blurs-the-source-before-the-cut.md): a hard edge leaks four times as many pixels past the ellipse at 32 times the amplitude.
- **The blend is written by hand over the raw buffer.** Measured against blurring the whole image and compositing an SVG ellipse mask: 6.4 ms against 179.5 ms, and 0 pixels changed outside every ellipse against 1 998 191 of 2 005 042. The composite route also forces one sigma across every face.
- **Clipping to the image bounds is a guard, not a path.** contracts refuses a Region whose `x + width` exceeds 1, so an ellipse cannot leave the image. The guard stays because a buffer overrun is the wrong way to find that out. **What it clips is the write, never the ellipse**: a face crossing the boundary is covered by the visible part of its own ellipse, at its own centre, radii and blur strength. Re-inscribing an ellipse in the sliver that is left would move the centre, shrink the blur and cover less of the face than the face needs — measured, an inscribed ellipse covers 78.4 % of the sliver against 88.6 %.
- **A Region that covers no whole pixel is not hidden and is not reported.** A box above zero can still round to zero pixels of width or height. There is nothing to blur and nothing was hidden, so no Redaction Record is issued: the Records are taken off the masks actually painted, not off the Unknown Faces. Nothing to paint at all returns the request's own buffer, the same as `blurUnknownFaces: false`.

### Order in the pipeline

`models` decodes once and annotates. `identify` produces the Matches. **redact hides, on the source.** `frame` produces the window. `compose` cuts, scales into the Image Slot and lays the template over it. The encode to `target.format` and `target.quality` is the last step and is not redact's.

### Units

Region boxes are fractions of the Source Image, per contracts. Inside redact they become pixel rectangles, rounded on both edges before the width is taken so the rectangle never drifts a pixel wider than the face. `left`/`top`/`width`/`height` for a pixel rectangle, matching sharp's `extract`; never `w`/`h` (ADR-0002).

### Dependencies

`@meco/contracts` and `sharp`. No store, no network, no models, no records, no fetch.

## Testing decisions

Vitest, through `packages/redact/index.ts` only. Every check names the mutation that must turn it red.

| Check                                                                                                  | Mutation that must make it fail                                                                                      |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| every face Region with no Match is in `redactions`; a matched one is not                               | treat a missing Match as known                                                                                       |
| an empty `matches` hides every face                                                                    | default to hiding none                                                                                               |
| a `person` Region is never in `redactions` and never blurred                                           | widen the kind filter past `face`                                                                                    |
| mean \|Laplacian\| inside each ellipse is under 20 % of the untouched image's (measured: 4.9 to 6.5 %) | skip the blur, or paint the mask on a rectangle offset by half its width                                             |
| the mask fades: the rim changes under a tenth of what the core changes                                 | a hard edge, coverage 1 everywhere inside the ellipse                                                                |
| every pixel outside every ellipse is the byte it was                                                   | blur the whole image and composite the ellipses; touch one pixel outside                                             |
| `blurUnknownFaces: false` returns the input buffer byte for byte                                       | apply the mask regardless of the policy                                                                              |
| a Region flush against either corner is hidden and the buffer keeps its length                         | skip the blur                                                                                                        |
| an out-of-range Region changes no pixel of the whole image outside the visible part of its ellipse     | drop the clip guard; or run the blend loop over the ellipse's width rather than the patch's                          |
| an out-of-range Region is covered by the visible part of its own ellipse, over 85 % of the sliver      | re-inscribe the ellipse in the sliver, which can reach only pi/4 of it                                               |
| a Region that rounds to no pixels yields no Record, beside one that does                               | take the Records off the Unknown Faces rather than off the masks painted                                             |
| redact makes no filesystem, network or encode call                                                     | any of `readFileSync`, `fetch`, `.jpeg()` inside `lib/`                                                              |
| the sigma read back off a step edge is 0.25 x that face's width                                        | any sigma that does not read this face's width: a literal, a constant, the call's first Region, or k halved to 0.125 |
| four masks in one call are the four masks drawn one at a time                                          | hoist sigma out of the loop                                                                                          |
| every changed pixel is inside the Region's rounded rectangle                                           | take the width from `round(box.width x 1280)` instead of from the two rounded edges                                  |

The detail figure is the shipped suite's own: a four-neighbour Laplacian over ITU luma, counted only where all four neighbours are inside the opaque core too, per face, on `artemis-2-crew.jpg` at 1280x1600. The design pass measured 7.0 % with a different definition; both are far under the bound, and the bound is what the check enforces.

**Sigma is measured, not inferred from what it leaves behind.** A detail check cannot police it: the curve is flat from k = 0.2, so halving the sigma leaves the |Laplacian| bound green, and the four recorded faces span only 100 to 114 px — too narrow a range for any detail measure to separate. So the check lays a mask over a synthetic step edge instead and reads the sigma straight off the result, because a Gaussian of sigma s spreads a step over a 25 % to 75 % rise of 1.349 s. Face boxes 200 and 400 px wide give rises of 62.25 and 124.50 px, exactly 2x, for sigmas of 46.15 and 92.29 against the nominal 50 and 100 — sharp's approximation reads 7.7 % under at both widths, identically, which is why the check bands the constant at 15 % and the proportion at 5 %. Provenance: darwin arm64, node v26.7.0, sharp 0.35.4, a 1024x512 synthetic step.

The rectangle check sweeps **2 px wider than the rectangle it defends**. Bounded by that rectangle it could not see a mask that ran past it, and would pass whatever the module did.

The out-of-bounds check sweeps the **whole image**, for the same reason taken further. Only half the hazard is sharp's: `extract` rejects a window off the image, but the hand-written blend indexes the buffer itself, and a blend that runs over the ellipse's width instead of the patch's wraps into the following row and past the end. Those wrapped pixels land at the far side of the image, where a sweep bounded by the patch's neighbourhood would never look. It was measured: with the clip in place and the blend widened, 40 641 channels changed outside the patch and every check bounded near it stayed green.

**Two checks reach under the contracts schema, and say so in the file.** `Box` refuses `x + width` above 1, so no validated Region can put an ellipse past the image edge and neither the clip guard nor the ellipse it does not shrink can be driven red through the public interface. `assignRegionIds` does not validate, so both checks build the Region by hand rather than parsing it. The alternative was shipping a check that only looks covered.

**The edge checks run on a checkerboard, not on the photograph.** A boundary check needs detail in the corner, and `artemis-2-crew.jpg` has none: mean |Laplacian| in its top-left 256x320 is 0.200, against 11.0 to 13.9 inside the four face cores. A ratio measured there measures the sensor noise, and skipping the blur leaves it under any bound worth writing.

**The isolation check stubs rather than reads the source.** `node:fs`, `node:fs/promises`, `node:http`, `node:https`, `node:net`, `node:tls`, `node:dns` and `node:child_process` are replaced for the module graph of that file, `fetch` is stubbed, and every encoder on sharp's prototype is replaced — `raw` and `toBuffer` are not encoders and stay. sharp itself loads as an external dependency and keeps the real modules, so the blur still runs.

No face detector runs in redact's suite. "No face can be found in the output" is the product promise and belongs to the cross-module conformance run, where the models are already loaded.

## Out of scope

- Cutting, scaling, encoding, storing or hashing. `compose` cuts and scales; the gateway emits.
- Counting which faces survive the crop. `frame`'s `projectIntoFrame`, called by the gateway.
- Plates, signs, screens, bodies. Fog on [#60](https://github.com/timschoch/meco/issues/60).
- Pixelation, solid blocks, or any second redaction style. The policy is `{ blurUnknownFaces: boolean }`.
- A Brand-level default for the policy. It rides on the FramingRequest ([#67](https://github.com/timschoch/meco/issues/67)).
- Rotating the mask for a tilted head. Measured as unnecessary for cover.
