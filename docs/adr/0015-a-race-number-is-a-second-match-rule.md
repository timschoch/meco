# ADR-0015 — a race number is a second Match Rule, and a Match says which rule made it

Status: **accepted, 7 Sep 2026**. Numbered 0015 by the orchestrator. Parent: [feature: a Number matcher (#227)](https://github.com/timschoch/meco/issues/227). Specs: [`../specs/identify.md`](../specs/identify.md), [`../specs/frame.md`](../specs/frame.md), [`../specs/records.md`](../specs/records.md), [`../specs/gateway.md`](../specs/gateway.md). Vocabulary: [`CONTEXT.md`](../../CONTEXT.md). Builds on [ADR-0012](0012-identify-open-set-matching-and-consented-enrolment.md) (the face rule), [ADR-0011](0011-records-postgres-rows-counted-deletes-and-a-sweep.md) (rows, counted deletes) and [ADR-0006](0006-frame-solves-in-closed-form-over-regions.md) (the rungs and the kart union). The number reader itself is [#232](https://github.com/timschoch/meco/issues/232), on main as `ppocr@1`.

## Context

A kart driver wears a crash helmet. YuNet finds the helmet, EdgeFace prints it, and ADR-0003's amendment then refuses that print as a Not-a-Face — correctly, because a print of a helmet carries no identity. So for the owner's own subject, the whole face rule is silent by design and meco cannot say "this is #24" at all.

What a person at the fence reads instead is the number painted on the kart. `ppocr@1` now puts it on the Annotation as a `number` Region whose Label is the digits. Turning that into an identity needs one more fact, and it is a fact of a Brand and not of the bytes: *number 24 is this Person, this season*.

## Decision 1 — a Match carries the rule that made it, as a discriminated union

`Match` was `{ regionId, personId, brand, similarity }`. It becomes a union on `by`: a `face` Match keeps `similarity`, a `number` Match carries `numberRegionId` and no similarity.

A cosine of two Face Prints is a measurement. A digit read off a kart and found on a list is not one, and there is no number that honestly goes in that field — a `1` would read as certainty nobody measured, and a `0` as its opposite. `by` has no default, so every producer states which rule answered and a consumer that reads `similarity` has to say which half it is reading.

Rejected: `similarity` optional on one shape. It makes "absent" mean two things — a number Match, and a face Match from a build that forgot — and puts the choice at every read site instead of at the parse.

## Decision 2 — a Person's race numbers are rows with a unique key, not an array column

`person_numbers (person_id, brand, number)` with the primary key over `(brand, number)`, cascading with the Person.

The rule that matters is that **one number is one Person within a Brand**. If two People of one Brand could carry `24`, a `24` read off a photograph would name both, and there is nothing in the photograph to break the tie with — the Match Rule would have to guess. So the rule has to be the database's, and Postgres has no unique index over the elements of an array: a `text[]` on `people` would have left it to whichever writer got there first. `Person.numbers: string[]` is still the seam every caller sees.

Rejected: a `text[]` column with a read-then-write check. It is the same code with the race left in.

## Decision 3 — the number rule associates by geometry, and names the kart

A `number` Region whose Label equals one of a Brand's Person's numbers matches the `vehicle` Region holding more than `NUMBER_ON_VEHICLE` (0.5) of the number's own box. Ties on that share go to the **smaller** vehicle box, then to the lower Region id. The Match names that `vehicle`, and carries the `number` Region as `numberRegionId`.

**The kart and not the digits**, because a Crop of a number plate is a picture of nothing, and the kart is what the photograph is about.

**The tighter container**, because a grid photograph really does hold vehicle boxes inside vehicle boxes. Measured on the recorded Annotation of `fixtures/karts/kart-grid-24.jpg` (`ppocr@1`, `dfine@1`, 6 Sep 2026): the `21` sits wholly inside `vehicle-8` (0.0918 of the frame), `vehicle-6` (0.2898) and `vehicle-5` (0.5527), all three at a share of 1.0000. Only the smallest is the #21 kart; the largest is a detection over the whole row.

**No container is no Match.** The same photograph's `227` is read at 0.6345 and overlaps no `vehicle` box at all. There is no kart to frame, so the rule says nothing.

The floor itself is **chosen, not measured**, and the measurement says why: over both committed recordings, every number that has a kart sits wholly inside it at a share of 1.0000, so every threshold in (0, 1] answers these five pairings identically. Dropping the floor from the code leaves both recordings' checks green, which is how that was found. Half of the digits on the kart is the least that can honestly be called painted on it, and what the floor refuses — a number straddling two karts with neither holding a majority — is proved on a hand-built geometry instead. A photograph landing inside that interval is what would let 0.5 itself be measured, and it gets its own ticket when one is found.

Rejected: putting the driver's `person` Region in the Match too. Composing "the kart and whoever is on it" is the `kart` rung's rule and already exists; a second copy on the Match would be two places for it to disagree.

## Decision 4 — frame's `match` rung leads on a face ahead of a number

The rung now takes both kinds. A face Match leads if there is one; a number Match leads only where there is none.

This is **not** a ranking of evidence. It is a ranking of compositions: a face Subject is the face box, which the Eye Line was calibrated on, and a number Subject is the kart union, which nothing here was calibrated on. The number rule is what answers when the face rule is silent, which is exactly the helmet. Ordering it second also leaves every framing meco produced before this ADR unchanged.

A leading number Match composes the kart around **its own** `vehicle` rather than the largest one. On `kart-grid-24.jpg` the largest is the row-wide `vehicle-5` at 0.5527 of the frame against the #24 kart's 0.1275, so seeding by size would frame the grid.

## Decision 5 — the Number Report is beside the Face Report, and reports numbers nobody owns

`render`, `crop` and `find_subjects` answer `numbers[]: { regionId, label, personId?, inFrame? }`. `faces[]` is untouched.

It is read off the Annotation and not off the Matches, so a number nobody enrolled is still reported: that is how a Brand discovers what to enrol. `inFrame` is absent on `find_subjects`, which cuts no window — a `true` there would be a claim about a picture that was never made. There is no `hidden`: redact blurs faces, and a race number is painted on a kart in a public place.

## Consequences

- Every existing Match producer, consumer and fixture states `by: "face"`. A stored `matches` row from before this ADR is untouched: the Replay path reads `identification.faces` and the webui reads a Match with no `by` as a face one.
- `set_person_numbers` is the gateway's first `PATCH`, so the HTTP Door reads a body on `POST` and `PATCH` rather than on `POST` alone. A list of numbers does not fit in a query string.
- A race number is refused at the door unless it is one to three digits, which is exactly what `ppocr@1` labels a Region with. A number outside that shape could never be read off a photograph and would be a dead letter nobody was told about.
- Two Annotations join the fixture set at `fixtures/karts/annotations/`, beside the photographs rather than inside one package's tests, because identify, frame and the gateway all read them. `pnpm --filter @meco/frame record <url>` writes them.
- A number read twice on two karts gives one Person two Matches. identify reports both; frame's lowest-Region-id tie-break chooses. Nothing in a photograph says which kart the Brand meant.
