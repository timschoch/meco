# ADR-0008 — redact blurs the Source Image, before any cut

Status: **accepted, 6 Sep 2026**. Ticket: [Module: redact (#85)](https://github.com/timschoch/meco/issues/85), settling [#67](https://github.com/timschoch/meco/issues/67), under the modular rebuild map [#60](https://github.com/timschoch/meco/issues/60). Spec: [`../specs/redact.md`](../specs/redact.md). Builds on [ADR-0001](0001-analytic-solver-over-search-based-crop.md), which made `frame` pure maths that touches no pixels. `compose` owns the cut and the scale: ADR-0009 and [`../specs/compose.md`](../specs/compose.md).

Provenance for every measurement here: darwin arm64, node v26.7.0, sharp 0.35.3 (libvips), `fixtures/faces/artemis-2-crew.jpg` at 1280x1600 with its four recorded faces from `fixtures/faces/detected.json`, and where a frame is involved, a centred 9:16 window scaled to 1080x1920.

## Context

Redaction can happen at two points: on the Source Image before `compose` cuts a window out of it, or on the finished frame after. The prototype did the latter and never wrote down why, so under the greenfield rule the question was reopened and measured rather than inherited.

Blurring first and resampling afterwards has a real cost: the resize kernel reaches across the mask's edge and spreads it. Blurring afterwards has a different cost: something between `frame` and `compose` has to own cutting pixels, and no module in the nine-module table does.

## Decision

**redact takes the decoded Source Image and returns the decoded Source Image with every Unknown Face hidden.** No window, no target size, no format. `compose` cuts `frame`'s window and scales it into the Image Slot; the gateway answers "did this face survive the crop" with `frame`'s `projectIntoFrame`.

- **The module keeps one job.** Cutting and scaling are `compose`'s work whatever redaction does, and a redact that took a window would be a redact that could be wrong about framing. The interface is the enforcement: it is never told the window, so it cannot have an opinion.
- **The mask is an axis-aligned ellipse inscribed in the Region's box, feathered over the outer sixth of its radius.** Landmarks are not used. All 40 landmarks across the 8 fixture faces already fall inside that ellipse, the worst at normalised radius 0.793 against a feather beginning at 0.833. Rotating each face about its centre and re-bounding the box axis-aligned _improves_ the margin — worst radius 0.692 at 10 degrees, 0.623 at 20, 0.576 at 30, 0.540 at 45 — because a rotated face's bounding box grows faster than the face inside it. The tilted head, the case landmarks exist for, is the case the upright ellipse covers best.
- **Gaussian sigma is 0.25 x the face's width in source pixels**, clamped to sharp's legal `[0.3, 1000]`. Measured as mean |Laplacian| inside the ellipse's opaque core against the untouched image: 11.4 % at k = 0.1, 8.6 % at 0.2, 8.3 % at 0.25 and 7.1 % at 0.35 on a 319 px face; 6.0 / 5.9 / 5.8 / 5.5 % on a 101 px one. Detail has collapsed by k = 0.1 and the curve is flat from 0.2, so 0.25 is chosen for sitting on the plateau — a detector box a little tight or a little loose does not move the result. A fixed sigma cannot serve 319 px and 101 px at once, which is why it scales.
- **The blend is hand-written over the raw buffer**, with sharp used for `extract`, `blur` and the raw round trip only. Against blurring the whole image and compositing an SVG ellipse mask: **6.4 ms against 179.5 ms**, and 0 pixels changed outside the ellipses against 1 998 191 of 2 005 042. The composite route also forces one sigma across every face — 34.3 px for face widths of 121, 132, 133 and 137 here, harmless on this photograph and wrong the moment one face is near and one is far.
- **The choice and the pixels are two functions.** Which faces are hidden is one sentence — a face Region with no Match — kept separate so a change to matching cannot break the mask and a change to the mask cannot change the policy.
- **redact holds no threshold and no gallery.** A similarity under identify's threshold arrives as the absence of a Match, so an empty `matches` list hides every face. That is the right answer for a caller that skipped identify: a face meco cannot name is a face it must not show.

## The accepted cost, and what pays it

Blurring before the cut means the mask edge is resampled. Measured over the 2 005 046 pixels outside every ellipse in the finished 1080x1920 frame, comparing a frame cut from the redacted source against one cut from the untouched source:

| mask edge                    | pixels changed outside the ellipse | max channel delta | leak reaches |
| ---------------------------- | ---------------------------------- | ----------------- | ------------ |
| feathered, 1/6 of the radius | 667 (0.033 %)                      | 2                 | r = 1.035    |
| hard edge                    | 2 717 (0.136 %)                    | 64                | r = 1.041    |

**The feather is the mitigation, and it is worth 4x in extent and 32x in amplitude.** A maximum channel delta of 2 in 255 is below JPEG quantisation and invisible; 64 is the halo the prototype's comment was worried about. The leak reaches 3.5 % past the ellipse's own radius either way, so the feather does not shrink the affected area much — it flattens what happens there.

For comparison, blurring after the cut changes 0 pixels outside the ellipses. That number is not free: it costs a module that owns cutting pixels.

## What was rejected

- **Redacting the finished frame.** It is what the prototype did and what the byte-equality measurement favours. It was rejected because it needs a pixel stage between `frame` and `compose` that the architecture does not have, and inventing one to save 667 pixels at delta 2 is the wrong trade. `compose` already cuts and scales for the Image Slot.
- **`sharp.composite` with an SVG mask.** Less code, 28x the cost, and it re-blends every pixel in the image by construction. The implementation built for the comparison was also simply wrong — a max channel delta of 255 outside the ellipses — which the byte-equality check caught on its first run. That is the argument for keeping the check, not a claim about every composite implementation.
- **Landmark-derived or rotated ellipses.** The case they exist for is the tilted head, and the tilt measurement runs the other way. They would buy a tighter-looking mask, not a safer one.
- **A Brand-level default for `blurUnknownFaces`.** Settled on [#67](https://github.com/timschoch/meco/issues/67): a Brand default makes redaction a fact about the Brand rather than about this output.
- **Re-running a face detector over the output inside redact's own suite.** It measures the real promise, and it costs redact an ONNX dependency it otherwise has no use for. It belongs to the cross-module conformance run, where the models are already loaded.
- **Reporting which faces were cropped out.** redact is not told the window. The gateway answers it with `frame`'s `projectIntoFrame`.

## Consequences

- **Every Unknown Face is hidden whether or not it survives the crop.** Strictly safer, and the wasted work is bounded: 6.4 ms for four faces at 1280x1600.
- **A redacted Source Image is a plausible cache key later.** The same photograph and the same Brand's Matches always give the same redacted pixels, because nothing about the output enters. Nothing caches it today; the property is recorded, not claimed.
- **Turning the policy off costs nothing.** `blurUnknownFaces: false` returns the input buffer byte for byte, and the test is a byte comparison against the input rather than against a re-derived copy.
- **The report is a list, not a count.** The prototype answered `blurred: 4`, which cannot say which face. Redaction Records keyed by the contracts Region id can, and `records` and the webui read them against the Annotation.
- **The clip to the image bounds is unreachable by a valid Region.** contracts refuses `x + width` above 1, so a mutation test cannot reach the guard through the public interface. It is kept anyway, and the spec says it is a guard rather than pretending it is covered. `assignRegionIds` does not validate, so the two checks that cover it build the Region by hand and name in the file that they are reaching under the schema.
- **The clip cuts the write, not the ellipse.** A face crossing the boundary keeps its own centre, radii and blur strength and is covered by whatever part of that ellipse lands on the image. Re-inscribing an ellipse in the visible sliver would move the centre, shrink the blur and cover less: measured on a 640x800 checkerboard with a box hanging off two edges, an inscribed ellipse reaches 78.4 % of the sliver — its `pi/4` ceiling — against 88.6 % for the visible part of the face's own ellipse.
- **A face that covers no whole pixel is not reported.** A box above zero can round to zero pixels of width or height. A Redaction Record says a face was hidden, so the Records are taken off the masks actually painted rather than off the Unknown Faces, and a Region that rounds away yields none.
- **The detail check has headroom, and the sigma needed a check of its own.** A 20 % bound against a measured 4.9 to 6.5 % cannot be made red by halving the sigma, because the curve is flat there. The mutations that work on the detail check are skipping the blur and painting the mask on a rectangle offset by half its width. Halving the sigma is caught by the separate sigma check below, which measures rather than infers.
- **The shipped sigma is read back off a step edge, not trusted.** A Gaussian of sigma s spreads a step over a 25 % to 75 % rise of 1.349 s, so a mask laid over a synthetic step measures its own blur strength. Face boxes 200 and 400 px wide give rises of 62.25 and 124.50 px — exactly 2x, so the scaling is confirmed at the seam rather than only in the source — for sigmas of 46.15 and 92.29 against the nominal 50 and 100. sharp's separable approximation reads 7.7 % under at both widths, identically; the proportion is what the decision rests on, and it is exact. Provenance: darwin arm64, node v26.7.0, sharp 0.35.4, a 1024x512 synthetic step, `packages/redact/tests/mask.test.ts`.

- **A tilted face is blurred with more background around it.** The upright ellipse over-covers a rotated face. That is the cosmetic price of the measurement above, and it is the direction to be wrong in.
