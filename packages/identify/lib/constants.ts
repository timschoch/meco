/**
 * The open-set rule's numbers, in one place, with what each was measured on.
 *
 * Inherited from [ADR-0003](../../../docs/adr/0003-face-recognition-licence-consent-and-threshold.md)
 * and carried forward by
 * [ADR-0012](../../../docs/adr/0012-identify-open-set-matching-and-consented-enrolment.md),
 * Decision 3. Every print they were measured on came from the prototype's ONNX
 * path; the shipped Enricher is only required to land within cosine 0.95 of
 * those prints (#121). A re-calibration ticket regenerates the fixture prints
 * through the shipped adapter and edits these numbers with the measurement.
 * Until it lands, `tests/calibration.test.ts` recomputes the identity table
 * from the committed prints on every run.
 */

/**
 * The similarity a face must reach against a Person to be named at all.
 *
 * Re-measured 6 Sep 2026 on `fixtures/faces/face-prints.json` at the 1600 px
 * Decode Bound: same-person worst 0.7263, stranger best 0.2979 over 33 pairs.
 * About 0.20 of room in either direction.
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
 */
export const MIN_FACE_PX = 40 as const;

/**
 * The similarity to a Not-a-Face Print at which a detection stops being a face.
 *
 * ADR-0003's amendment, from 21 detections in `fixtures/karts/`: nearest
 * non-face 0.6365, nearest real face 0.6542. The band is 0.0365 wide upwards
 * and closed downwards, which is why growing the Not-a-Face set needs a
 * re-measurement. Exported here with the rule it belongs to; the Not-a-Face
 * Prints themselves and the verdict that reads them land with their own ticket.
 */
export const NOT_A_FACE_THRESHOLD = 0.6 as const;

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
 * returns 512 (`fixtures/faces/face-prints.json`, every print). A vector of
 * another length did not come from this Model whatever its `{ name, version }`
 * says, and scoring it term by term would compare the first few dimensions of
 * two unrelated networks and could clear the threshold on nothing.
 */
export const PRINT_DIMENSIONS = 512 as const;
