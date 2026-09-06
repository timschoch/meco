# Spec: the compose module

Parent: [Module: compose (#84)](https://github.com/timschoch/meco/issues/84). Reasons: [ADR-0009](../adr/0009-compose-takumi-measured-zones-look-in-code.md). Vocabulary: [`CONTEXT.md`, compose](../../CONTEXT.md#compose). Shared types: [`docs/specs/contracts.md`](contracts.md). Package layout: [`packages/README.md`](../../packages/README.md).

## Problem statement

A caller has a photograph, a Brand and some text and wants a finished social image at a Placement. The text must not land on the face, the face must not be cut off by the text, and the result has to look like the Brand every time. Today nothing says where a Template's text will fall before the picture exists, so the crop cannot avoid it.

## Solution

One package, `@meco/compose`, with two pure functions. `plan` says what a Template will cover at one Placement with these Fields, with no picture in hand: the Image Slot in pixels, the Occlusion Zones and the Subject Area in slot fractions. `render` takes the redacted Source Image and the window frame chose, cuts it, scales it into the slot, draws the Template over it in the Brand's Look, and encodes the final bytes. Templates are TSX modules in the package; Looks are code beside them.

## User stories

1. As the gateway, I want `plan` to give me the Image Slot size and the zones before I call frame, so that the FramingRequest carries `target`, `occlusion` and `subjectArea` from one source.
2. As the frame module, I want Occlusion Zones and the Subject Area in Image Slot fractions, so that I keep the Subject clear of the overlay without seeing the Template.
3. As the gateway, I want `render` to take the redacted Source Image and frame's window and return encoded bytes, so that no other module resamples or encodes.
4. As a Template author, I want to write one TSX file that default-exports its contract and imports one thing from compose, so that adding a Template is one PR with no registry edit elsewhere.
5. As a Template author, I want to mark the Image Slot and the covering blocks with two components, so that the zones follow my layout instead of a table I keep by hand.
6. As a Template author, I want the Look typed, so that a wrong colour name fails the typecheck and not the picture.
7. As an MCP client, I want the Template catalogue with each Template's Fields as JSON Schema and an example, so that I can fill a Template unaided.
8. As an MCP client, I want the Placement catalogue with pixel sizes, so that I know what `instagram/story` means before I ask for it.
9. As a caller, I want a Template that does not support the Placement I named refused with a clear code, so that I never get a layout the designer did not intend.
10. As a caller, I want a JPEG at quality 90 by default when the output is a photograph, and PNG or WebP when I ask, so that the file suits the Channel.
11. As the redact module, I want to hand over the full blurred source in source pixels, so that the blur is applied once whatever the crop.
12. As the records module, I want the same Template, Placement and Fields to give the same Plan and the same bytes, so that a Render is reproducible from its call record.
13. As a maintainer, I want every Template to pass the same layout checks, so that a Template whose zones leave the slot or whose text overflows cannot merge.
14. As a maintainer, I want one golden image per Template and Placement, so that a lost logo or a wrong colour is caught by the suite.
15. As the owner, I want fonts committed with their licence text, so that a cold start makes no network call and a font cannot be added without its licence.
16. As a future caller with my own TSX, I want the Template contract to be a plain module shape, so that a later loader can register it without changing compose.

## Implementation decisions

### Interface

Four entry points, per `packages/README.md`.

`index.ts`, what the gateway calls:

```ts
plan({ template, placement, brand, fields }) → Promise<Plan>
  Plan = { imageSlot: Size, occlusion: Box[], subjectArea?: Box }
render({ template, placement, brand, fields, source: DecodedImage, window: Box, format?, quality? })
  → Promise<{ bytes: Uint8Array, mime }>
cut({ source: DecodedImage, window: Box, target: Size, format?, quality? })
  → Promise<{ bytes: Uint8Array, mime }>   // a bare Crop: no Template
templates(brand?) → TemplateDescription[]       // id, brand, description, placements, fields as JSON Schema, example
PLACEMENTS: readonly Placement[]                 // the closed catalogue
ComposeError { code: "unknown_template" | "unknown_brand" | "placement_not_supported" | "invalid_fields" | "framing_mismatch" }
```

`template.ts`, the only import a Template author needs: the `Template` and `Look` types, `TemplateProps`, the Markers `ImageSlot` and `Occludes`, and the Building Blocks `PhotoCard`, `Scrim` and `TextBlock`.

`placements.ts`: `Placement`, `PlacementId` and the catalogue, also reachable from `index.ts`.

`conformance.ts`: `layoutConformance({ images, templates? }) → Check[]`, the layout suite below. `templates` names the Templates to check; without it the suite runs the ones compose ships. What a caller passes is registered through `registerTemplates` against compose's own Looks, so a Template whose Brand has no Look is refused there and not at the first Check. Its own entry point, like [`packages/contracts/conformance.ts`](../../packages/contracts/conformance.ts), so the fixture pictures the Checks take never reach the runtime graph. A Template author outside compose runs the same Checks from their own Vitest file.

### The Template contract

A Template is one TSX module default-exporting `{ id, brand, description, fields, placements, subjectArea?, example, render }`.

- `id` is `<brand>-<name>`.
- `fields` is a zod object; the gateway turns it into the MCP input schema. Fields hold text and small values, never a URL to fetch: compose fetches nothing.
- `placements` is closed. A Placement not in it is refused with `placement_not_supported`.
- `subjectArea?` is static per Placement, in Image Slot fractions.
- `render(props)` returns the element. `props = { fields, look, placement, image: { src, width, height } }`. The Template places `<ImageSlot src={image.src}>` exactly once and wraps what covers the picture in `<Occludes>`.
- `example` is real data that renders, as in the prototype's catalogue.

A Template must lay out identically whatever the image bytes are; the Plan depends on it.

### The Plan

`plan` builds the tree with a blank image descriptor of the slot's size, lays it out with takumi's `measure()`, walks the measured tree in step with the source tree, and reads the `ImageSlot` box and every `Occludes` box off the absolute transform. Zones are translated from canvas pixels to Image Slot fractions and clipped to the slot; a zone wholly outside the slot is dropped rather than reported as a rectangle of no area, which no FramingRequest would accept. Only a Template a caller registered can produce one — the layout suite forbids a shipped Template a zone the slot's edge cuts. `imageSlot` is the slot box in pixels. `subjectArea` is copied from the Template for that Placement.

### The Render

`render` re-plans (0.6–3.6 ms measured), then:

1. Refuses with `framing_mismatch` when the window's aspect, in source pixels from the Decoded Image's size, differs from the Image Slot's by more than one pixel on either axis.
2. Cuts `window` from `source` and scales it to the slot with sharp (`extract` + `resize`, lanczos3), yielding raw RGBA at slot size. Fill, never cover: frame's window already has the slot's shape up to one pixel of rounding, and a `cover` fit would crop it a second time and undo the framing.
3. Hands takumi the tree with the slot's bitmap drawn 1:1 and the Look's fonts and logo registered.
4. Encodes `png | jpeg | webp`. Default `jpeg` at quality 90 for a Template with an Image Slot; `png` only when asked.

No fetch, no store, no crop decision. `source` is a Decoded Image and `window` a Box in Source Image fractions, both contracts types; the gateway lifts the window (frame's `windowFraction`) out of the Framing. compose imports nothing from `@meco/frame`. Precondition: `source` is at the Annotation's own resolution, the one frame divided by. redact blurs in place and does not resize, so this holds today; a resize step anywhere before compose would scale the window correctly but make the one-pixel tolerance below mean something else.

### The Cut

`cut` is the same pixel path with no Template over it: `extract`, `resize` to the target with lanczos3, the same `framing_mismatch` refusal read against the target instead of the Image Slot, and the same encoder at the same defaults. The picture is already the canvas's size, so takumi draws it 1:1. It exists because compose owns pixels and the gateway's bare Crop route must not reach for sharp to skip a Template (#88).

### Building Blocks

`PhotoCard`, `Scrim` and `TextBlock` on `template.ts`, beside the Markers. A Template may import only that entry, which is why two Templates for one Brand were ~90 % the same file (#116); the answer is to put what they share on the far side of the rule rather than to relax it. The blocks are layout and never Look: every colour, family, size and spacing is a prop, and colour props take `string | undefined` because a Look's colour map is open.

### Looks

One folder per Brand id under compose's private implementation: a token module (`colors`, `fonts`, `headingFamily`, `bodyFamily`, `logo`, `logoAlt?`) and the asset files beside it. `assets/` at the repo root moves in. Every font file ships with its licence text. compose refuses `unknown_brand` for a Brand with no Look.

Fonts: Eina 02 (Hope Family, already committed), Outfit and Figtree variable (laica), Barlow and Barlow Condensed 400/600/700 (Swiss Hutless). 816 KB total. Barlow, Barlow Condensed, Outfit and Figtree are OFL. Eina 02 is proprietary — a Textaxis face carrying "All rights reserved" and no licence URL — and its licence is held by the owner, text pending; `packages/compose/lib/looks/hopefamily/fonts/LICENCE.txt` records the notices the binaries carry and nothing more (#116).

### The registry

One map from Template id to Template, filled from static imports in one file. Every lookup goes through it. A later loader for a caller's own TSX registers into the same map and touches nothing else. Not built.

### The Placement catalogue

Owned by compose. The prototype's seven: `linkedin/post` 1200x1200, `linkedin/wide` 1200x627, `instagram/post` 1080x1350, `instagram/story` 1080x1920, `x/post` 1600x900, `facebook/post` 1200x630, `facebook/story` 1080x1920. Carried on the measurement that nothing in them was wrong; each row is a fact about a Channel, not a design choice.

### Renderer

takumi (`@takumi-rs/core`, `@takumi-rs/helpers`), one `Renderer` per process with the Looks' fonts registered once at first use. Numbers and rejected options in ADR-0009.

## Testing decisions

Tests cross the entry points only, enforced by dependency-cruiser. Prior art: contracts' `schemaConformance` for shapes; nothing in the repo for pictures yet.

**Layout checks**, `layoutConformance` from `conformance.ts`, run by [`packages/compose/tests/layout.test.ts`](../../packages/compose/tests/layout.test.ts) for every Template x declared Placement with the Template's `example`:

- exactly one `ImageSlot` in the measured tree, of a positive size;
- every Occlusion Zone parses as a contracts `Box`, so its fractions are in `[0, 1]`;
- no Occlusion Zone is cut by the Image Slot's edge, so the Template's own overlay stays on its own Image Slot;
- every Occlusion Zone wholly outside the Image Slot is dropped from the Plan, and every one over it is kept. The other half of the rule above, and the half a Template may break without being wrong: a zone off the slot covers no part of the picture;
- every text run inside its own box on the inline axis. That axis only: a run's reported height is the font's line box, not the CSS one, so a Template that tightens `lineHeight` puts every run over its box by design;
- the Plan is identical with no image bytes, with a flat 9x16 placeholder and with a fixture photo;
- `subjectArea`, when declared, is a valid Box;
- no more Occlusion Zones than the `MAX_OCCLUSION_ZONES` a FramingRequest holds, so a Template that cannot be framed fails here and not at the gateway.

Exact assertions. The Plan's own numbers carry no tolerance: `tests/plan.test.ts` names the text block in whole Image Slot pixels, 92, 1437, 896 by 391 for the example Fields. The two containment rules allow half a pixel, because takumi lays out in floats and a run that exactly fills its line comes back a fraction over; anything a reader would see is whole pixels.

Each check names the mutation that turns it red: a `<div>` where `<Occludes>` belongs, a title three times longer than the box, a Template that reads `image.width` into its layout. The two halves of the clipping rule are separated by a pair of fixture Templates registered through `templates`, drawing the same frame and differing only in where the second zone sits.

**Golden images**, one per Template x Placement, rendered from a fixture photo and the `example` Fields, compared by mean absolute pixel difference against a threshold set from a cross-platform measurement (takumi is byte-deterministic on one machine; Linux CI is the open question). Regenerated only by an explicit script, never by the suite.

**The bare Crop**: its own golden at 1080x1920 on the kart fixture, at the same threshold, plus a byte-for-byte check that `cut` and `render` put the same pixels in the Image Slot. Read over the part of `swisshutless-story` that nothing covers — the band its scrim holds at alpha 0, less the brand stripe — because compose ships no empty Template and registering one for a test would put it in the catalogue every caller reads.

**Interface checks**: `plan` and `render` refuse each error code with the named input; `cut` refuses `framing_mismatch` on the same rule; `render` with a window two pixels off the slot's aspect fails `framing_mismatch` and one pixel off passes; the default format is JPEG and `format: "png"` yields PNG bytes.

Every check is proved able to fail before it ships.

## Out of scope

- Carousels and PDF binding. The interface is per picture; a `bind` entry point is additive later.
- Loading a caller's TSX without a rebuild (#65 fog). The registry leaves the door open.
- Fetching images or fonts, storing output, choosing the crop, redaction.
- A Template without an Image Slot (pure text card). The contract allows it (`plan` returns no slot, `render` takes no source), but no such Template ships in v1 and no ticket covers it.
- The webui's rendering of Plans and Renders.

## Further notes

The Placement is not the FramingRequest `target`. `target` is the Image Slot in pixels, which for a Template with a 42 % hero column is narrower than the Placement. The gateway takes it from the Plan.
