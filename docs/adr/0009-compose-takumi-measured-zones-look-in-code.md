# ADR-0009 — compose: takumi, zones measured from the layout, the Look in code, and the last pixel stage

Status: **accepted, 6 Sep 2026**. Parent: [Module: compose (#84)](https://github.com/timschoch/meco/issues/84). Builds on [Templates are TSX in code (#65)](https://github.com/timschoch/meco/issues/65), [What belongs in a FramingRequest (#70)](https://github.com/timschoch/meco/issues/70) and [ADR-0005](0005-contracts-annotation-framingrequest-and-zod.md). Spec: [`../specs/compose.md`](../specs/compose.md). Decided by the orchestrator with the compose agent, the owner away; the grilling is ledgered on #84.

## Context

compose lays a Template over a picture and produces the finished Render. Before the picture exists it must say which parts of the Image Slot the Template will cover, so frame can keep the Subject out from under the text. The prototype rendered with takumi, declared no zones at all, fetched fonts from Google on every cold start and kept the Brand's look in a `brands.ts` beside the templates. The greenfield rule gives none of that a vote; each choice below stands on a measurement or a property.

## Decision 1 — takumi renders, because of the numbers and the layout pass

Measured on this machine (Apple M4, 24 GB, Node 26.7.0), one 1080x1920 story (photo cover, gradient scrim, logo PNG, two local OTF weights, three text blocks), PNG out, three fresh processes, ten warm renders each, medians:

| Renderer                                    | Cold start to first PNG | Warm render | Layout only              |
| ------------------------------------------- | ----------------------- | ----------- | ------------------------ |
| `@takumi-rs/core` 2.13.5 (native)           | 220–466 ms              | 178–251 ms  | 0.6–3.6 ms (`measure()`) |
| `satori` 0.18.4 + `@resvg/resvg-js` 2.6.2   | 430–2639 ms             | 384–554 ms  | none                     |
| Chrome via `puppeteer-core` 24, page reused | 1.5–13.0 s              | 644–762 ms  | none                     |

Two fresh renderers in one process give byte-identical raw output (mean absolute difference 0 over 8.3 MB), so golden images need no tolerance for takumi itself.

takumi is 2–3x faster than satori warm, 3–4x faster than Chrome, needs no browser in the gateway container, and is the only one with a layout pass that stops before rasterising. Decision 2 depends on that pass. Licence MIT/Apache-2.0.

**Rejected.** satori+resvg: slower, MPL-2.0, images only as data URIs, no layout API. Chrome: a browser process per container, a 1.5 s floor on cold start, the richest CSS, which no Template needs.

## Decision 2 — Occlusion Zones are measured from the layout, the Subject Area is declared

A Template's text block is as tall as its title. A static table of zones per Placement would be wrong on every call whose title wraps differently. So compose lays the Template out with `measure()`, finds the Marker nodes and reads their boxes. Measured: the marked boxes are identical with no image bytes, with a 9x16 grey placeholder and with a 1280x1600 photo, so the Plan needs Fields and a Placement and nothing else.

Two Markers, provided by compose: `ImageSlot` (exactly one) and `Occludes` (any number). They render to plain containers. takumi's measured tree carries no ids, but it mirrors the source tree node for node, so compose walks both in step and reads absolute positions off the transform. Verified on a nested tree.

The **Subject Area** stays a static declaration per Placement on the Template. Where the face should sit is design intent, not a layout result.

**Rejected.** A dry render and pixel analysis: a hundred times slower and it cannot tell text from photo. A static zone table: wrong per call, as above.

## Decision 3 — the Look is code in compose, fonts included

`records` owns the Brand: the unit of ownership and the privacy wall (#63). Its look, the colours, fonts and wordmark, is what Templates are written against, and it is typed: a Template reads `look.colors.banana`. A look in the database cannot be typechecked against the TSX that uses it, and the two are edited together. So the **Look** lives in compose, keyed by the Brand id, and `assets/` moves in beside it. This closes the fog item "Brand does two jobs": the wall stays Brand, the look becomes Look.

Fonts are committed, not fetched. The prototype fetched Outfit, Figtree, Barlow and Barlow Condensed from Google Fonts on every cold start. The files the three Looks need total 816 KB (Outfit variable 111 KB, Figtree variable 63 KB, six Barlow statics at 102–110 KB), all OFL, redistribution allowed. With them in the repo compose makes no network call in either of its two functions, which is what makes it a pure module and keeps cold start where it was measured.

## Decision 4 — two pure calls, and compose is the last pixel stage

`plan` and `render`, no state between them. The gateway calls `plan`, hands the Image Slot size to frame as `target` and the zones into the FramingRequest, then calls `render` with the redacted Source Image and the window frame chose. `render` lays the tree out again (0.6–3.6 ms) rather than carrying a handle, and refuses a window whose aspect, in source pixels, differs from the slot's by more than one pixel on either axis.

The window arrives as a contracts `Box` in Source Image fractions, lifted out of frame's Framing by the gateway. compose does not import `@meco/frame`: one field does not earn a package edge, and compose's dependencies stay at contracts plus its two native libraries.

compose receives the **whole** redacted Source Image as a Decoded Image plus that window, cuts it, scales it into the Image Slot, draws the Template over it and encodes. The alternative owner of cut-and-scale was the gateway, which would have made it a pixel stage. redact blurs on the full source, frame chooses the window, compose is the one module that resamples and the only one that encodes. Format and quality come from the FramingRequest's `target`.

Cut-and-scale is done with sharp, not takumi's own bitmap scaling. Measured (same machine, sharp 0.35.4), a raw RGB source → 9:16 window → 1080x1920 slot → template over it → JPEG q90, medians of 8: sharp `extract` + `resize` (lanczos3) 31–35 ms flat across 1600x1000, 1280x1600 and 6400x4000 sources; takumi `Bitmap` with `objectFit` 41, 49 and 119 ms. sharp is in the gateway container anyway: something there decodes the Source Image for redact.

## Consequences

- compose has two native dependencies, takumi and sharp, and no network. A Template author imports one thing: the Template type and the two Markers.
- A Template must render the same tree whatever the image bytes are; a Template that sizes itself to the photo would make the Plan lie. The layout tests assert it.
- Adding a Template is a PR. The registry is one map filled from static imports, so a later loader for a caller's own TSX adds entries there and touches nothing else. Wanted, not built (#65).
- Carousels are out of v1. The interface is per picture; binding pages into a PDF is an additive entry point later.
