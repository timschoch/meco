# Spec: the identify module

Parent: [Module: identify (#87)](https://github.com/timschoch/meco/issues/87). Reasons: [ADR-0012](../adr/0012-identify-open-set-matching-and-consented-enrolment.md), building on [ADR-0003](../adr/0003-face-recognition-licence-consent-and-threshold.md). Vocabulary: [`CONTEXT.md`, identify](../../CONTEXT.md#identify). Shapes: [`contracts.md`](contracts.md). Neighbours: [`models.md`](models.md), [`records.md`](records.md), [`store.md`](store.md), [`frame.md`](frame.md), [`redact.md`](redact.md). Package layout: [`packages/README.md`](../../packages/README.md).

## Problem statement

A Brand enrols the people it may show and asks meco to put their names on the faces in a photograph. Every other face is a stranger and must stay one. The wrong answer is not a missed name, it is a stranger's name on a published photograph with their face left sharp, which is what happened when a Person was enrolled from the back of a crash helmet (ADR-0003, amendment). The module that decides has to say "nobody" often and confidently, refuse to learn a face that is not one, and never learn a face whose owner did not agree.

## Solution

One package, `@meco/identify`, one factory, two methods. `match` takes an Annotation and a Brand and answers with the Matches for that Brand and one Face Verdict per face, by arithmetic over the Face Prints the Annotation already carries and the Face Prints the Brand's People were enrolled with. `enrol` takes a Person, a photograph and a consent date, runs the photograph through the Annotator, checks the chosen face is an Identifiable Face, and files the bytes, the File, the Annotation and the Reference Photo row through store and records. It never touches SQL, never touches a pixel, and never calls a model at match time.

## User stories

1. As the gateway, I want one call that turns an Annotation and a Brand into this call's Matches, so that frame and redact receive the same list and I assemble nothing.
2. As a Brand, I want a face that is nobody I enrolled to come back unknown, so that a stranger is blurred and never named after whoever was nearest.
3. As a Brand with two People who look alike, I want a face between them to come back unknown rather than assigned by the third decimal, so that a published post never carries the wrong name.
4. As a Brand, I want a Person with four Reference Photos to be easier to recognise than one with one, so that enrolling more photographs helps and never hurts.
5. As a Brand, I want a Person enrolled by me to be invisible to every other Brand, so that the privacy wall is a property of which rows were read.
6. As redact, I want the absence of a Match to be the only signal I need, so that I hold no threshold.
7. As frame, I want every Match with its similarity, so that the surest face leads and `persons` narrows who leads on my side.
8. As the webui, I want to know why each face was not named (compared and unknown, never compared, too small, not a face), so that "two faces, one named, one uncompared" is a sentence I can render.
9. As a Brand, I want to be told when a Reference Photo I enrolled can no longer lend its name, so that I re-enrol from a better photograph instead of wondering why a Person stopped matching.
10. As a Brand, I want to enrol a Person from a photograph with one face in it by sending the bytes, so that enrolment is one call.
11. As a Brand, I want a photograph with several faces to come back with the faces to choose from, so that I name the right one and send it again.
12. As the owner, I want enrolment refused without a consent date, so that no biometric template of an unconsenting person ever exists in meco.
13. As the owner, I want a photograph of a crash helmet, a face too small to print, or a face the Enricher could not align refused at enrolment with a message naming the photograph that would work, so that the failure of ADR-0003's amendment cannot recur.
14. As the owner, I want a refused enrolment to leave nothing in the store or the database, so that a refusal is not a leak.
15. As records, I want the Reference Photo row to carry the Region identify chose, the Face Print it computed and the consent date, so that Erasure removes everything and the row is one fact.
16. As a maintainer, I want the threshold, the margin, the size floor and the Not-a-Face threshold in one place with their measurement beside them, so that a re-calibration is one diff.
17. As a maintainer, I want a swap of the print Model to make every existing print uncompared and every enrolled print unusable rather than silently wrong, so that a re-enrolment is forced and not forgotten.
18. As a maintainer, I want the calibration to run in the gate from committed prints with no model loaded, so that the numbers in the ADR are numbers a test recomputes.
19. As an agent calling identify alone, I want `match` to work on any Annotation with face Regions, so that identification is a tool and not only a stage.

## Implementation decisions

### The seam

```ts
// packages/identify/index.ts
export function identify(deps: IdentifyDeps): Identify;

export interface IdentifyDeps {
  records: Records; // people.list, people.get, people.enrol, files.ensure, annotations.put
  store: Store; // put under people/<brand>/<personId>
  annotate: Annotator; // the models client in production, a fixture fake in tests
}
export type Annotator = (
  bytes: Uint8Array,
  options: { hash: string }
) => Promise<Annotation>;

export interface Identify {
  match(input: MatchRequest): Promise<Identification>;
  enrol(input: EnrolRequest): Promise<Enrolment>;
}

export interface MatchRequest {
  annotation: Annotation;
  brand: string;
}

export interface Identification {
  matches: Match[]; // contracts Match, sorted by regionId
  faces: FaceVerdict[]; // one per face Region, sorted by regionId
  unusableReferencePhotos: string[]; // Reference Photo ids left out of the comparison
}

export type FaceVerdict = { regionId: string } & (
  | {
      verdict: "match";
      personId: string;
      similarity: number;
      runnerUp?: number;
    }
  | { verdict: "unknown"; best?: number; runnerUp?: number }
  | { verdict: "uncompared"; reason: "no-print" | "other-model" }
  | {
      verdict: "not-identifiable";
      reason: "too-small" | "not-a-face";
      detail: string;
    }
);

export interface EnrolRequest {
  brand: string;
  personId: string;
  bytes: Uint8Array;
  contentType: string;
  consentAt: Date; // required; see Consent
  regionId?: string; // which face, when the photograph has several
}

export type Enrolment =
  | { status: "enrolled"; photo: ReferencePhoto; annotation: Annotation }
  | {
      status: "choose";
      faces: { regionId: string; box: Box; pixels: number }[];
    };

export class IdentifyError extends Error {
  code:
    | "consent_required"
    | "unknown_person"
    | "no_face"
    | "unknown_region"
    | "too_small"
    | "not_a_face"
    | "no_print"
    | "other_model";
}

export const MATCH_THRESHOLD: 0.5;
export const MATCH_MARGIN: 0.05;
export const MIN_FACE_PX: 40;
export const NOT_A_FACE_THRESHOLD: 0.6;
export const PRINT_MODEL: { name: "edgeface"; version: "1" };
```

`Annotation`, `Match`, `Box` come from `@meco/contracts`; `Records`, `ReferencePhoto` from `@meco/records`; `Store` from `@meco/store`. Every test and every caller crosses this file and no other.

### What `match` does

1. Reads `records.people.list(brand)`: every Person of this Brand with every Reference Photo's Face Print, one query.
2. Drops enrolled prints whose `model` is not `PRINT_MODEL`, and enrolled prints at or above `NOT_A_FACE_THRESHOLD` to any Not-a-Face Print. Both land in `unusableReferencePhotos`. A Brand that enrolled before a Not-a-Face Print was added to the set is protected here, and told.
3. For every `face` Region, in id order, one Face Verdict:
   - no `facePrint` → `uncompared: no-print` (the Enricher could not align it, or did not run);
   - `facePrint.model` not `PRINT_MODEL` → `uncompared: other-model`;
   - shorter side below `MIN_FACE_PX` in the Decoded Image → `not-identifiable: too-small`;
   - similarity at or above `NOT_A_FACE_THRESHOLD` to a Not-a-Face Print → `not-identifiable: not-a-face`, `detail` naming the reference;
   - otherwise compared: best similarity per Person, the runner-up is the best other Person. `match` when best ≥ `MATCH_THRESHOLD` and best − runnerUp ≥ `MATCH_MARGIN` (no runner-up passes the margin); `unknown` otherwise, with `best` and `runnerUp` reported.
4. `matches` is the `match` verdicts as contracts Matches, `brand` set.

No `persons`: frame narrows who leads and redact must not blur an enrolled Person the caller did not name ([`frame.md`](frame.md), "persons narrows who may lead and nothing else"). No model call: the prints are on the Annotation. No cache: a Match is tens of dot products (ADR-0011, Decision 2). A Brand with no People yields every face `unknown` or `uncompared`, and an empty `matches`.

The size floor is judged in the Decoded Image, not the photograph: `min(box.width × width, box.height × height) × min(1, DECODE_BOUND / max(width, height))`, because that is the size EdgeFace saw. `DECODE_BOUND` is imported from `@meco/models`' client entry (decision on #87, requested on #119); identify holds no copy.

### What `enrol` does

In order. Steps 1 and 2 write nothing; step 3 writes the bytes, and from there every exit that is not an enrolment removes them again:

1. `records.people.get(brand, personId)`; missing → `unknown_person`. `consentAt` absent → `consent_required`. Nothing is ever written for a Person who does not exist or has not consented.
2. `hash` is the sha256 of `bytes`.
3. `store.put("people/<brand>/<personId>", bytes, contentType)` → Store Key and hash.
4. `store.signedUrl(key, MAX_SIGNED_URL_SECONDS)`, then `annotate({ url }, { hash })`. The Annotation is the shared one under that Content Hash; `annotate` is the models client's `annotate` with the hash check on, and the URL form is the only one a photograph over 4.5 MB can use (#201).
5. Choose the face: no face Region → `no_face`; `regionId` given and not a face Region of this Annotation → `unknown_region`; several faces and no `regionId` → `{ status: "choose", faces }`, sorted by size, largest first; one face → that one. A `choose` is not an enrolment, so the bytes go with it.
6. Identifiable Face: no `facePrint` → `no_print`; other `model` → `other_model`; below `MIN_FACE_PX` → `too_small`; at or above `NOT_A_FACE_THRESHOLD` to a Not-a-Face Print → `not_a_face`. Each message says which photograph would work, as the prototype's did (helmet off, closer, square on).
7. `records.files.ensure` with the File's hash, mime and size; `records.annotations.put(annotation)`; `records.people.enrol({ personId, brand, hash, storeKey, regionId, facePrint, consentAt })`. The `people/…` key goes on the Reference Photo row. The `files` row is the hash plus its `sources/` key if the same bytes were ever uploaded as a Source Image; records owns that rule (decision on #87, carried to #86).

**A refused photograph leaves no object under the prefix and no row.** How that is kept changed on #235: the Annotator takes a Signed URL and can only fetch what is already in the store, so the bytes are written before the gates in steps 5 and 6 rather than after them, and the rule is "nothing written survives a refusal" instead of "nothing is written before the refusals" (ADR-0012, Decision 4, amended). The cost is a crash between the write and the removal, which is the window step 7 always had, made longer.

The same photograph enrolled twice is two rows on one key (records, "People, Reference Photos and Erasure"); identify does not deduplicate, records counts.

### The constants and their provenance

| Constant               | Value        | Provenance                                                                                                                                                            | Room                 |
| ---------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `MATCH_THRESHOLD`      | 0.50         | ADR-0003 D3; measured 6 Sep 2026 on `fixtures/faces/face-prints.json`, `edgeface/1` at 1600 px: same-person worst 0.7263, stranger best 0.2978 over 33 pairs          | 0.20 either way      |
| `MATCH_MARGIN`         | 0.05         | ADR-0003 D3: chosen, not measured; the fixtures hold no look-alikes                                                                                                   | unmeasured           |
| `MIN_FACE_PX`          | 40           | ADR-0003 amendment; judged in the Decoded Image                                                                                                                       | none below 40        |
| `NOT_A_FACE_THRESHOLD` | 0.60         | ADR-0003 amendment; measured 6 Sep 2026 over the 11 swept detections in `fixtures/karts/`, `edgeface/1` at 1600 px: nearest non-face 0.6364, nearest real face 0.6545 | 0.0364 up, none down |
| `PRINT_MODEL`          | `edgeface/1` | `docs/specs/models.md`, the Catalogue                                                                                                                                 |                      |

**Measured against the shipped adapter, 6 Sep 2026 (#177).** Both fixture print files are re-taken by `pnpm --filter @meco/models print:fixtures` through the Catalogue's own `edgeface/1` at the Decode Bound, and each file records the Model, the bound and the ONNX Runtime that produced it. Every row above moved by less than 0.0006 against the prototype's ONNX path — worst per-print drift 0.999996 cosine over 21 prints, median 0.999999 — so both bands are the inherited ones and no constant moved. `packages/identify/tests/calibration.test.ts` recomputes both tables every run and refuses a print file from another Model or another bound. ADR-0012 Decision 3 carries the table with its deltas.

**The margin is flat here, and the calibration says so.** Scored the way the rule scores, only three fixture faces reach `MATCH_THRESHOLD` — all one Person, all named correctly — and the worst of their margins is 0.5251, ten times `MATCH_MARGIN`. The six that do not reach it run down to a margin of 0.0005, and every one is refused by the threshold before the margin is consulted. The fixture set gives 0.05 nothing to be measured against; it stays a chosen number.

**Max per Person, not centroid.** Measured 6 Sep 2026 on the one fixture Person with three prints, each held out in turn: max 0.8681 / 0.8681 / 0.8229, centroid 0.9101 / 0.8351 / 0.8015. Centroid wins once and loses twice; the threshold was calibrated on max.

### The Not-a-Face Prints

`lib/not-a-face-prints.ts`, generated from the detections marked `reference: true` in `fixtures/karts/expected.json`, one today (`on-track-rear-helmet.jpg#0`, CC0). Committed in code because they are about a model and not about a person; never a records row. Growing the set needs CC0 or public-domain photographs (`fixtures/karts/LICENCE.md`) and a re-run of the Not-a-Face sweep, because the band has no room.

### Consent

`consentAt` is required on `EnrolRequest` and refused when absent. ADR-0003 Decision 2 made it optional so that "absent" could be read back; identify tightens that to "absent is refused", and records keeps the column nullable because it never fills it and rows enrolled elsewhere may lack it. ADR-0012 records the tightening.

### The kart

The brief says "given a kart, this is the kart". A kart is frame's composition of a `vehicle` Region and the `person` on it (`CONTEXT.md`, Kart Producer), not a Region Kind and not an identity. identify v1 says nothing about non-face Regions; `faces` lists face Regions only.

### Dependencies and boundaries

`@meco/contracts`, `@meco/records` (entry point), `@meco/store` (entry point), `@meco/models` (the client entry `index.ts` only, for `Annotator`'s production adapter type and `DECODE_BOUND`). No `sharp`, no ONNX, no `pg`, no fetch. identify never touches SQL: every row goes through `Records`.

## Testing decisions

Vitest, through `packages/identify/index.ts` only, `tests-through-entrypoints` enforced. Dependencies are real where an adapter exists and fake only at the model: `records(pgliteDatabase(), memoryStore())`, `memoryStore()`, and an `Annotator` that returns a committed fixture Annotation for a known hash. No network, no ONNX, no fake `Records`; a fake would be a third adapter nobody keeps honest.

Fixture Annotations are built from `fixtures/faces/detected.json` (YuNet boxes and landmarks) and `fixtures/faces/face-prints.json` (prints, 7 people lettered A to G), and from `fixtures/karts/face-prints.json` for the helmet, parsed with the contracts schema inside the test so a drift fails here.

| Check                                                                                                       | Mutation that must turn it red         |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| a stranger's face is `unknown` with `best` under 0.50                                                       | drop the threshold test                |
| a Person's held-out print is `match` with the right `personId`                                              | invert the comparison                  |
| two People whose best differ by under 0.05 give `unknown` with both numbers                                 | drop the margin test                   |
| a Person with three prints matches on the best, not the mean                                                | aggregate by mean                      |
| a face with no `facePrint` is `uncompared: no-print`, and `matches` omits it                                | treat a missing print as a zero vector |
| a print from `edgeface/2` is `uncompared: other-model`                                                      | drop the model gate                    |
| a face under 40 px in the Decoded Image is `too-small`, one over is compared                                | judge in photograph pixels             |
| the helmet print is `not-identifiable: not-a-face`, naming the reference                                    | drop the Not-a-Face check              |
| an enrolled helmet print is in `unusableReferencePhotos` and lends no name                                  | compare against every enrolled print   |
| a Person of Brand A is never a Match for Brand B                                                            | list every Brand's People              |
| `matches` and `faces` are sorted by Region id number                                                        | sort by position in `regions`          |
| `enrol` without `consentAt` throws `consent_required`; store prefix and rows stay empty                     | skip the check                         |
| `enrol` on a helmet photograph throws `not_a_face`; nothing written                                         | write before validating                |
| `enrol` on a two-face photograph without `regionId` returns `choose`, largest first                         | pick the first                         |
| `enrol` with `regionId` on a two-face photograph enrols that face                                           | ignore `regionId`                      |
| `enrol` writes under `people/<brand>/<personId>/` and the row names that key and the chosen print           | write under `sources/`                 |
| the calibration file recomputes the table above from the committed prints and fails on a single false Match | raise a stranger pair over 0.50        |

Every check is proved able to fail by its mutation before it ships. Commit the green state first, then mutate, then `git restore`.

**Live acceptance per ticket** against the deployed gateway: enrol one fixture-free Person (the owner's own photograph, or a synthetic consenting subject) on `meco-records-eu` and the private store, `match` a second photograph of them, then erase and post the empty listing. The fixtures are not a precedent for enrolment (ADR-0003 D2).

## Out of scope

- Any pixel: decoding, alignment, embedding are models'; blur is redact's.
- `persons` narrowing and who leads: frame's.
- A per-Brand or per-call threshold. One rule, calibrated once.
- Identifying anything that is not a face: the kart is frame's composition.
- A Brand-scoped identification cache (`identifications`): rejected in ADR-0011.
- Re-embedding stored Reference Photos after a Model swap. The row keeps the print's `model`; a re-enrolment ticket comes with the swap.
- Deleting a Person or a Reference Photo: `records.people.erase`, called by the gateway.
- Growing the Not-a-Face set. Needs CC0 photographs and a re-measurement; its own ticket when a non-face is found.

## Further notes

`Match`, `Identifiable Face`, `Uncompared Face`, `Not-a-Face Print`, `Person`, `Reference Photo` and `Face Print` are defined under Faces in `CONTEXT.md` and are not redefined here. `Unknown Face` is redact's word for a face with no Match; identify's `unknown` verdict is the compared subset of it.

`CONTEXT.md`'s Face Print entry still says "meco-faces returns" and "meco-faces computes them"; models does now. Flagged on #87 for the orchestrator, not changed here.
