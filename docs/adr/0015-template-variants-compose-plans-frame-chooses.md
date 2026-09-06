# ADR-0015 — Template Variants: compose plans every one, frame chooses, the Framing names it

Status: **accepted, 7 Sep 2026**. Ticket: [compose+frame: Template variants so the caption moves out of the Subject's way (#228)](https://github.com/timschoch/meco/issues/228). Amends [ADR-0009](0009-compose-takumi-measured-zones-look-in-code.md) (the Plan) and [ADR-0006](0006-frame-solves-in-closed-form-over-regions.md) (occlusion aims but does not size). Specs: [`../specs/compose.md`](../specs/compose.md), [`../specs/frame.md`](../specs/frame.md), [`../specs/gateway.md`](../specs/gateway.md). Vocabulary: [`CONTEXT.md`, Variant](../../CONTEXT.md#compose). Decided by the implementing agent, the owner away; ledgered on #228.

## Context

Production Call `e0466f34` (6 Sep 2026, `bf32674`): the owner's race photograph, 800x533, into `swisshutless-story` at 1080x1920. A 3:2 source into a 9:16 window is a full-height column of 300x533. frame composed the two front karts as the Subject (`x 0.405–0.918, y 0.594–0.903`) and had no vertical slack to aim with: the karts landed under the caption block at `occlusionClear: false`, and since the Subject is 411 px wide in a 300 px window the ladder ended on `clip`. ADR-0006 rules out zooming to clear an overlay, and rightly; nothing in the Template let the caption go anywhere else.

## Decision 1 — a Template declares Variants; compose plans them all

A **Variant** is the same Template with its blocks somewhere else: same Fields, same Look. A Template lists them most preferred first, each with its own Subject Area per Placement, because the clear part of the frame moves with the blocks. `plan` answers one Plan per Variant, each named. A Template that declares none is the one-Plan case and nothing about it changes.

Rejected: a second Template per layout. The catalogue would double, a caller would have to choose, and the choice depends on the picture, which the caller has not looked at.

## Decision 2 — frame chooses, and `occlusionClear` outranks `satisfied`

`frameVariants` frames every Variant on its own FramingRequest and answers the winner. The order read: `occlusionClear`, `satisfied`, the larger Free Area, the smaller Subject Area shortfall, the Template's order. The ticket proposed `satisfied` first. Measured on the Call above, both Variants clip, leave the same Free Area and the same shortfall; only `occlusionClear` differs, and it is the defect. So it leads. Ties are read to `1e-9`, because two mirrored layouts leave Free Areas equal by construction and arrive at them by different sums — found when the gateway picked `caption-top` for the dark-visor kart on the last bit of a double.

`satisfied: true` on the race photograph is unreachable by any Variant: no layout widens the window. The ticket's acceptance is corrected to `variant: "caption-top"` and `occlusionClear: true`, which is what the photograph can give.

## Decision 3 — the Variant is derived, so it rides on the Framing and never on the Request Hash

The gateway builds one FramingRequest per Plan, calls frame once (one `frame.crop` Step), paints the Fill whose name frame answered, and stores the Framing verbatim, `variant` included. The Request Hash covers the request; the same request over the same bytes frames the same, so the Variant adds nothing to the key. The Annotation is untouched: which layout a picture got is true of one output, not of the bytes.

## Decision 4 — every Framing carries `scale`, and says when it is an upscale

`scale` is the target over the window on the constrained axis; `lowResolution: true` sits beside it exactly when it is above 1. The race photograph reads 3.6. A number a caller can act on, where before the only sign was a soft picture.

## Consequences

- `plan` answers a list. Every caller walks it; the gateway is the only one in production.
- `swisshutless-story` and `hopefamily-story` gain `caption-top`; their `caption-bottom` renders byte-identical to before. `hopefamily-post` stays one layout: its wide shape needs a mirrored column and Subject Areas of its own, a design and not a flip.
- `unknown_variant` joins compose's closed error set; the gateway maps it to `500`, since it only ever hands compose a name off compose's own Plan.
- The Call View prints the Variant on its own line under the Framing.
