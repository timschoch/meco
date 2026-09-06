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

`MATCH_THRESHOLD` 0.50, `MATCH_MARGIN` 0.05, `MIN_FACE_PX` 40 in the Decoded Image, `NOT_A_FACE_THRESHOLD` 0.60, best similarity per Person with the runner-up the best other Person, all as ADR-0003 left them. Re-measured 6 Sep 2026 on `fixtures/faces/face-prints.json` at the 1600 px bound: same-person worst 0.7263, stranger best 0.2979, ADR-0003's table to the fourth decimal. Centroid aggregation measured on the one three-print Person, held out in turn: 0.9101 / 0.8351 / 0.8014 against max 0.8681 / 0.8681 / 0.8228. Not better; rejected.

The Not-a-Face band is 0.0365 wide in one direction and closed in the other. The Enricher that will produce production prints is not the one those prints came from. So the constants ship inherited and the first re-calibration ticket, blocked on the Enricher, regenerates both fixture print files through the shipped adapter, re-runs both sweeps as a Vitest file, and edits the table in the spec. A rule with no band cannot be assumed to survive a new print path; the assumption is what ADR-0003's amendment was written about.

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
