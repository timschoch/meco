# ADR-0017 — identify: a visor is not a face, and a second line above the Not-a-Face threshold lifts the blur

Status: **accepted, 7 Sep 2026**. Ticket: [identify: a visor is not a face (#248)](https://github.com/timschoch/meco/issues/248). Spec: [`../specs/identify.md`](../specs/identify.md). Vocabulary: [`CONTEXT.md`, Not-a-Face](../../CONTEXT.md#identify). Builds on [ADR-0003](0003-face-recognition-licence-consent-and-threshold.md) (the Not-a-Face rule) and [ADR-0012](0012-identify-open-set-matching-and-consented-enrolment.md) (Decision 3, the re-measured threshold). Decided by the orchestrator with the identify agent, the owner away; the measurement is ledgered on #248.

## Context

Production Call `a42442e0`: the face Detector boxed the mirrored visor of kart 24 as `face-1`, identify said `not-identifiable: not-a-face`, redact hid it, and the story carried a blurred blob on a helmet. The owner asked for the root cause: a face inside a helmet is not a face to blur.

The 0.60 Not-a-Face threshold could not be reused for that. ADR-0012 measured its band as negative: it refuses every non-face and one real face (`paddock-mixed#8`, a child at 0.6545) as the price. That price is fine for refusing a name, because the refusal keeps the blur. It is not fine for lifting one.

## Decision 1 — a fifth Face Verdict, `not-a-face`, at a second line

`NOT_A_FACE_CERTAIN = 0.85`. A face Region over the size floor whose print sits at or over it to a Not-a-Face Print is the helmet itself: `match` answers `{ verdict: "not-a-face", detail }`, and it appears in no Match. `NOT_A_FACE_THRESHOLD` stays at 0.60 with its `not-identifiable: not-a-face` verdict; `enrol` refuses both kinds as `not_a_face`, as before.

The order is load-bearing: the certainty is asked **after** the size floor. A 23 px face at the barrier of `street-karting-crowd` prints at 0.9320 to the reference, and under the floor nothing a print says is trusted.

### The measurement, 7 Sep 2026

Nine recordings under `fixtures/karts/annotations/`, taken through the Catalogue at `f6f625b` (`edgeface/1` at the 1600 px Decode Bound, onnxruntime 1.29.0, arm64). The grid was re-recorded: its first recording carried no print on the visor, the Enricher today prints it, and production saw the print. Every other field agrees to the fifth decimal.

| Row                                                         | Value                |
| ----------------------------------------------------------- | -------------------- |
| printed faces at or over 40 px, across 9 recordings         | 15                   |
| the reference itself, `on-track-rear-helmet face-1`         | 1.0000               |
| the grid's visor, `kart-grid-24 face-1`, 85 px              | **0.9461**           |
| nearest other, `on-track-visor-open face-1`, visor up       | **0.6933**           |
| next, `paddock-mixed face-6`, the child                     | 0.6545               |
| under the floor, best: `street-karting-crowd face-8`, 23 px | 0.9320               |
| band                                                        | 0.2528               |
| room                                                        | 0.096 up, 0.157 down |

`packages/identify/tests/calibration.test.ts` recomputes the table every run and asserts the two neighbours and the sub-floor row.

## Decision 2 — the gateway withholds the Region from redact

redact's contract stands: no threshold, no verdict, the absence of a Match is its only signal (spec, user story 6). The gateway hands `redact` the Annotation's Regions without every face Region identify called `not-a-face`; the Face Report carries the verdict with `hidden: false`. contracts and records are untouched: `FaceReport.verdict` is `FaceVerdict["verdict"]` and widens by itself, and the Identification is stored unread.

Rejected: redact reading the Identification. It would learn identify's vocabulary to skip one Region, and every later verdict would be a redact change. Rejected: models dropping the Region. "This box is a helmet" is true of the bytes and could live on the Annotation, but the Not-a-Face Prints and their thresholds are identify's, and a second copy of the rule in the Enricher is the drift ADR-0012 Decision 5 was written against.

## Considered and rejected

- **Geometry** (ticket candidate 1): a face wholly inside a `person` Region that sits on a `vehicle`. Drivers' person-in-vehicle shares run 0.39 (the grid) to 1.00, a bystander's reaches 0.66, so no floor separates. Worse, it would have unblurred three real faces: the crowd's two kart drivers (printed at 0.4646 and 0.1466 to the helmet, compared) and the paddock's driver with the visor up (0.5092, compared). Fails both acceptance checks on its own.
- **A helmet class** (candidate 2): a new adapter with a licence and a measurement, for a question the print already answers.
- **Distance from every real face print** (candidate 3 as written): does not separate. The visor's nearest real face print is 0.6711; small crowd faces reach 0.6564. Nearness to the Not-a-Face Print is what separates, and that is the existing rule with a second, higher line.
- **Moving 0.60 up to lift the blur**: the child at 0.6545 sits inside the current refusal; the two lines answer two questions and cannot be one number.

## The limit

A helmet with the visor up (`on-track-visor-open`, 0.6933) is under the certainty and stays `not-identifiable`, hidden. Whoever is behind it is blurred rather than shown, which is the safe side. The real face in a helmet that must stay a face is the paddock driver at 0.5092: compared, unknown to any Brand that did not enrol them, hidden by default.

## Not decided here

- A second Not-a-Face reference print (a visor-down helmet from the front), which would widen the band. Needs CC0 photographs (`fixtures/karts/LICENCE.md`) and a re-run of both sweeps.
- What the Redaction Record and the Call View should say about a Not-a-Face beyond `hidden: false`.
