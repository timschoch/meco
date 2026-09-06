# ADR-0012 — identify: arithmetic over the Annotation, consent before enrolment, and inherited thresholds re-measured against the shipped adapter

Status: **accepted, 6 Sep 2026**. Numbered 0012 by the orchestrator. Parent: [Module: identify (#87)](https://github.com/timschoch/meco/issues/87). Spec: [`../specs/identify.md`](../specs/identify.md). Vocabulary: [`CONTEXT.md`, identify](../../CONTEXT.md#identify). Builds on [ADR-0003](0003-face-recognition-licence-consent-and-threshold.md) (the threshold, the margin, the Not-a-Face rule, consent), [ADR-0005](0005-contracts-annotation-framingrequest-and-zod.md) (a Face Print rides on its Region with its Model), [ADR-0007](0007-models-one-route-two-stage-catalogue.md) (EdgeFace is an Enricher) and [ADR-0011](0011-records-postgres-rows-counted-deletes-and-a-sweep.md) (no identification cache; Matches live on the Call). Decided by the orchestrator with the identify agent, the owner away; the grilling is ledgered on #87.

## Context

The prototype's `src/people.ts` did five jobs: it called the face service to detect and embed, read Face Prints out of Blob listings, decided the open-set rule, narrowed by `persons`, and wrote Reference Photos as overwriting blobs. The rebuild moved four of those away: models puts the Face Print on the Annotation, records holds People and Reference Photos as rows, frame narrows by `persons`, store refuses overwrites. What is left is the decision, and it has to be made without any of the prototype's arguments about how the data arrives.

ADR-0003 calibrated the numbers the decision uses on prints from the prototype's ONNX path. The shipped Enricher is a new export of the same weights, and #121 only requires it to land within cosine 0.95 of those prints.

## Decision 1 — `match` is arithmetic over the Annotation and one records read

`identify({ records, store, annotate }).match({ annotation, brand })` compares the Face Prints already on the Annotation's face Regions with the Face Prints of the Brand's People from `records.people.list(brand)`. It calls no model, reads no bytes, keeps no cache. It answers with the contracts Matches and one Face Verdict per face Region, so that "compared and unknown", "never compared", "too small" and "not a face" are four different answers and not one silence.

Rejected: a `match` that re-embeds. ADR-0011 kept the print in the cached Annotation for this one consumer. Rejected: `Match[]` alone as the answer. `CONTEXT.md` requires an Uncompared Face to be countable, and the webui has to explain a face that was not named.

## Decision 2 — `persons` and the kart are not identify's

The prototype narrowed the answer by `persons` at the end and threw on unknown ids. frame now narrows who leads and keeps every Match as a face worth keeping ([`../specs/frame.md`](../specs/frame.md)); redact must not blur an enrolled Person the caller merely did not name. identify therefore returns every Match for the Brand and takes no `persons`. "This is the kart" is frame's composition of a `vehicle` and the `person` on it; identify says nothing about non-face Regions.

## Decision 3 — the open-set rule is inherited, and the inheritance is measured before it is trusted

`MATCH_THRESHOLD` 0.50, `MATCH_MARGIN` 0.05, `MIN_FACE_PX` 40 in the Decoded Image, `NOT_A_FACE_THRESHOLD` 0.60, best similarity per Person with the runner-up the best other Person, all as ADR-0003 left them. Centroid aggregation measured on the one three-print Person, held out in turn: 0.9101 / 0.8351 / 0.8015 against max 0.8681 / 0.8681 / 0.8229. Not better; rejected.

The Not-a-Face band is 0.036 wide in one direction and closed in the other, and the Enricher that produces production prints was not the one those prints came from. A rule with no band cannot be assumed to survive a new print path — the assumption is what ADR-0003's amendment was written about — so the constants shipped inherited and marked unverified, and #177 measured them.

### The measurement, 6 Sep 2026 (#177)

`pnpm --filter @meco/models print:fixtures` re-takes `fixtures/faces/face-prints.json` and `fixtures/karts/face-prints.json` through the Catalogue's own `edgeface/1`, at the 1600 px Decode Bound, on onnxruntime 1.29.0. Each file records that provenance, and `packages/identify/tests/calibration.test.ts` refuses a file printed by another Model or at another bound. Both sweeps then run as that Vitest file, with their tables printed.

| Row                                         | Inherited (prototype ONNX) | Measured (shipped `edgeface/1`) | Delta    |
| ------------------------------------------- | -------------------------- | ------------------------------- | -------- |
| same-person worst, 3 pairs                  | 0.7263                     | **0.7263**                      | +0.00004 |
| stranger best, 33 pairs                     | 0.2979                     | **0.2978**                      | −0.00011 |
| identity band                               | 0.4284                     | **0.4285**                      | +0.00015 |
| nearest non-face, `paddock-mixed#7`, 52 px  | 0.6365                     | **0.6364**                      | −0.00015 |
| nearest real face, `paddock-mixed#8`, 40 px | 0.6542                     | **0.6545**                      | +0.00034 |
| held out, `on-track-visor-open#0`, 100 px   | 0.6935                     | **0.6933**                      | −0.00015 |
| clearance below the nearest non-face        | 0.0365                     | **0.0364**                      | −0.00015 |
| Not-a-Face band                             | −0.0177                    | **−0.0181**                     | −0.00049 |

**No constant moved.** Every row moved by less than 0.0006, an order of magnitude under the 0.02 ADR-0003 set as the floor for tuning 0.60 at all. Per-print drift over the 21 prints replaced: worst 0.999996 cosine (`podium-trophy.jpg#0`), median 0.999999. #121's golden bound of 0.95 is three orders of magnitude looser than what identify's band could absorb here; the two numbers are not in tension, they are measuring different risks — 0.95 is what the general case needs when the Decode Bound shrinks a photograph, and 0.999996 is what this fixture set, committed at the bound, actually does.

The refused set is unchanged: `on-track-visor-open#0`, `paddock-mixed#8`, `paddock-mixed#7`, and no non-face is accepted.

**The margin is flat, and the calibration now prints why.** Three fixture faces reach `MATCH_THRESHOLD`, all one Person and all named correctly, worst margin 0.5251. The other six run down to a margin of 0.0005 and are every one refused by the threshold before the margin is consulted. `MATCH_MARGIN` stays chosen rather than measured.

**Two counts in ADR-0003's amendment are stale, and are not being rewritten there.** It says "21 detections" and "11 real faces of 57 px or more"; `fixtures/karts/` holds 13 hand-classified detections — 10 real faces and 3 non-faces — of which 12 are printed (`paddock-mixed#1`, a real face at 60 px, is the one the warp refuses) and 11 are swept past the reference print: 9 real faces and 2 non-faces. Four of the 10 real faces are 57 px or more. The three headline cosines reproduce to the fourth decimal, so those are a stale count and not a different measurement. ADR-0003 is history and keeps its numbers; this note is where the correction lives, and `calibration.test.ts` asserts 11 / 9 / 2 every run.

`PRINT_MODEL` is `edgeface/1`. A print from any other `{ name, version }` is uncompared; an enrolled print from another is unusable and reported. That turns a model swap into a forced re-enrolment, which ADR-0003's Consequences said was the only path and ADR-0005 made checkable.

## Decision 4 — consent is a precondition, and a refused enrolment writes nothing

`enrol` requires `consentAt` and refuses without it. ADR-0003 Decision 2 made the field optional so that "nobody said so" could be read back; that was a rule for a system that already held records without it. The rebuild holds none. Absent consent is now refused at the seam, and records keeps the column nullable because records never fills it (ADR-0003 D2 stands there).

`enrol` annotates, chooses, checks, and only then writes: the bytes under `people/<brand>/<personId>/`, the File, the Annotation, the Reference Photo row. A photograph refused for size, for resembling a Not-a-Face Print, for an unalignable face or for the wrong print Model leaves nothing behind, so a refusal is not a leak and the Erasure proof has nothing to miss.

## Decision 5 — real adapters in the suite, a fake only at the model

identify's tests run `records` over pglite and `memoryStore`, both real adapters under their own conformance suites, and fake only the Annotator, which returns committed fixture Annotations for known hashes. Rejected: a fake `Records`. It would be a third adapter with no suite keeping it honest, and the Erasure and two-enrolments-one-key rules are exactly what a fake gets wrong.

## Considered and rejected

- **A Brand-scoped identification cache.** Rejected in ADR-0011; a Match is tens of dot products.
- **A per-Brand threshold.** One calibration, one rule; a Brand-specific number would need a Brand-specific fixture set nobody has.
- **`match` taking `persons`.** Two modules narrowing is one too many, and the second one would have to know frame's tiers.
- **Growing the Not-a-Face set now.** Needs CC0 photographs and a re-measurement; the band has no room to absorb a guess.
- **An `identify` conformance export.** identify has no adapters of its own; its suite is its conformance.

## Not decided here

- The re-calibrated numbers. The re-calibration ticket edits the spec's table and this ADR's Decision 3 with the measurement and its date.
- Whether `CONTEXT.md`'s Face Print entry, which still names meco-faces, is rewritten to name models. Flagged on #87.
