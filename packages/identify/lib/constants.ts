/**
 * The open-set rule's numbers, in one place, with what each was measured on.
 *
 * Inherited from [ADR-0003](../../../docs/adr/0003-face-recognition-licence-consent-and-threshold.md)
 * and carried forward by
 * [ADR-0012](../../../docs/adr/0012-identify-open-set-matching-and-consented-enrolment.md),
 * Decision 3, and re-measured there on 6 Sep 2026 (#177) against the prints
 * the shipped Enricher takes: both fixture print files come from the
 * Catalogue's own `edgeface/1` at the Decode Bound, and every row moved by
 * less than 0.0006 against the prototype's ONNX path. No constant moved.
 *
 * `tests/calibration.test.ts` recomputes both tables from the committed prints
 * on every run, and refuses a fixture file printed by another Model or at
 * another bound. Re-print with `pnpm --filter @meco/models print:fixtures`.
 */

/**
 * The similarity a face must reach against a Person to be named at all.
 *
 * Measured 6 Sep 2026 on `fixtures/faces/face-prints.json`, printed by
 * `edgeface/1` at the 1600 px Decode Bound: same-person worst 0.7263, stranger
 * best 0.2978 over 33 pairs. About 0.20 of room in either direction.
 */
export const MATCH_THRESHOLD = 0.5 as const;

/**
 * How far ahead of the second-best Person the best has to be.
 *
 * ADR-0003 Decision 3: chosen, not measured. The fixture set holds no
 * look-alikes, so nothing here can confirm it — a face between two People is
 * refused rather than decided by the third decimal.
 */
export const MATCH_MARGIN = 0.05 as const;

/**
 * The shortest side, in the Decoded Image, a face must have to be compared.
 *
 * ADR-0003's amendment. Judged after the Decode Bound, because that is the size
 * the Enricher saw; a face measured in the photograph's own pixels would pass
 * this floor at any resolution.
 *
 * Every detection in the Not-a-Face sweep clears it — the smallest is 40 px —
 * so the floor is not silently doing the Not-a-Face rule's work.
 */
export const MIN_FACE_PX = 40 as const;

/**
 * The similarity to a Not-a-Face Print at which a detection stops being a face.
 *
 * ADR-0003's amendment, re-measured 6 Sep 2026 over the 11 swept detections in
 * `fixtures/karts/`: nearest non-face 0.6364, nearest real face 0.6545. The
 * band is 0.0364 wide upwards and closed downwards, which is why growing the
 * Not-a-Face set needs a re-measurement. Exported here with the rule it
 * belongs to; the Not-a-Face Prints are in `not-a-face-prints.ts`.
 */
export const NOT_A_FACE_THRESHOLD = 0.6 as const;

/**
 * The similarity to a Not-a-Face Print at which a detection *is* the helmet:
 * a Not-a-Face, with nothing behind it to name and nothing to hide.
 *
 * A second, higher line above {@link NOT_A_FACE_THRESHOLD}, never the same
 * one. 0.60 refuses a name and keeps the blur, and it has a real face inside
 * it (`paddock-mixed#8`, 0.6545) as its accepted price; a line that lifts a
 * blur can afford no such price. Measured 7 Sep 2026 (#248) over every
 * printed face of every recording in `fixtures/karts/annotations/`,
 * `edgeface/1` at the 1600 px bound: the two helmets sit at 1.0 (the
 * reference itself) and 0.9461 (the mirrored visor of kart 24, 85 px); the
 * nearest thing at or over {@link MIN_FACE_PX} that is not one is the
 * visor-up helmet of `on-track-visor-open` at 0.6933, then the child at
 * 0.6545. The band is 0.25 wide; 0.85 sits 0.096 under the visor and 0.157
 * over the visor-up helmet.
 *
 * Asked only after the size floor. A 23 px face at the barrier of
 * `street-karting-crowd` prints at 0.9320 to the reference, over this line:
 * under the floor nothing about a print is trusted, and that face stays
 * hidden. `tests/calibration.test.ts` prints the table and asserts all three
 * rows every run.
 */
export const NOT_A_FACE_CERTAIN = 0.85 as const;

/**
 * The one Model whose Face Prints the numbers above were calibrated on. A print
 * from any other `{ name, version }` is an Uncompared Face and an enrolled one
 * is an Unusable Reference Photo, so a Model swap forces a re-enrolment rather
 * than producing a wrong answer (ADR-0012, Decision 3).
 */
export const PRINT_MODEL = { name: "edgeface", version: "1" } as const;

/**
 * How many floats a Face Print from {@link PRINT_MODEL} has.
 *
 * `@meco/contracts` fixes a Face Print's length to "at least one" and its norm
 * to one, because the length is a property of the network and not of the
 * shape. The Print Model is what fixes it, so the check belongs here: EdgeFace
 * returns 512, asserted by the adapter on every print it emits and by
 * `fixtures/faces/face-prints.json` on every print committed. A vector of
 * another length did not come from this Model whatever its `{ name, version }`
 * says, and scoring it term by term would compare the first few dimensions of
 * two unrelated networks and could clear the threshold on nothing.
 */
export const PRINT_DIMENSIONS = 512 as const;

/**
 * The share of a `number` Region's own box that must lie inside a `vehicle`
 * Region before the number counts as painted on that kart.
 *
 * **Chosen, not measured**, and the measurement says why it could not be.
 * Over the recorded Annotations of `fixtures/karts/kart-grid-24.jpg` and
 * `kart-24-target.jpg` (`ppocr@1` and `dfine@1`, 6 Sep 2026) every number that
 * has a kart at all sits **wholly** inside it, at a share of 1.0000 — five
 * pairings, five exact containments. Every threshold in (0, 1] therefore picks
 * the same kart for every one of them, and nothing in the fixture set can
 * prefer one point in that interval to another. The one number with no kart,
 * the grid's `227`, overlaps no vehicle box at all and is refused at any
 * threshold above zero.
 *
 * What the floor is for is the case the fixtures do not hold: a number that
 * overhangs its kart's box, or sits between two of them. Half of the digits on
 * the kart is the least that can honestly be called painted on it. A
 * photograph that lands inside the interval is what would let this be
 * measured, and it gets its own ticket when one is found.
 */
export const NUMBER_ON_VEHICLE = 0.5 as const;
