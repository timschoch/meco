# Spec: the contracts module

Parent: [Module: contracts (#80)](https://github.com/timschoch/meco/issues/80). Settles [What belongs in an Annotation (#69)](https://github.com/timschoch/meco/issues/69) and [What belongs in a FramingRequest (#70)](https://github.com/timschoch/meco/issues/70). Reasons: [ADR-0004](../adr/0004-contracts-annotation-framingrequest-and-zod.md). Vocabulary: [`CONTEXT.md`, contracts](../../CONTEXT.md#contracts). Package layout: [`packages/README.md`](../../packages/README.md).

## Problem statement

Nine modules built by nine agents in parallel have to agree on what an image analysis is, what one output asks for, and how a detector proves it speaks the same language. Without one package that owns those shapes, each module invents its own box, its own region id and its own idea of a version, and the seams leak at the first integration.

## Solution

One package, `@meco/contracts`, whose only runtime dependency is zod. It exports the three shared types with their schemas, the adapter edge, and the Conformance Checks. Every other package imports it; it imports none of them.

## User stories

1. As the models host, I want one `ModelAdapter` interface and one `DecodedImage` input, so that every hand-written adapter is called the same way.
2. As an adapter author, I want Conformance Checks I run from my own Vitest file, so that a wrong box, a missing licence or a drifting output fails my PR and not the integration.
3. As the frame module, I want Regions that carry fractions, a Region Kind, a Label and landmarks, so that I compose Subject Boxes without knowing which Model ran.
4. As the identify module, I want a face Region to carry its Face Print with the Model that made it, so that I compare like with like and refuse a print from another network.
5. As the records module, I want an Annotation keyed by Content Hash that names its schema number and the Models that filled it, so that a stale row is a miss and never a wrong answer.
6. As the compose module, I want to emit Occlusion Zones and a Subject Area in Image Slot fractions, so that frame keeps the Subject clear of the overlay without seeing the template.
7. As the redact module, I want the redaction policy on the FramingRequest and the Matches beside it, so that I hide every face that is not a named Person for this Brand.
8. As the gateway, I want every schema to be a zod object, so that the MCP tool input schema and the Hono validator are the contract itself.
9. As the webui, I want the FramingRequest stored verbatim in the call record, so that I can show what was asked.
10. As a caller, I want every rectangle spelled `x, y, width, height` in fractions, so that nothing I read depends on a resolution.
11. As any module author, I want a schema round-trip check I apply to my own samples, so that serialisation never drifts from the type.
12. As a future adapter author, I want a Model swap to invalidate cached Annotations by construction, so that no photograph keeps answering from a Model that no longer runs.
13. As the models host, I want contracts to assign Region ids, so that identify's keys stay stable however my adapters order their output.

## Implementation decisions

### The three shared types

| Type | Holds | Keyed by | Lifetime |
|---|---|---|---|
| Annotation | `schema, hash, mime, width, height, producedBy, regions` | Content Hash | forever, shared by every Brand |
| FramingRequest | `brand, source: { hash }, target, pinTo, persons?, anchor?, subjectArea?, occlusion, redaction` | nothing | one call, kept in the call record |
| Match | `regionId, personId, brand, similarity` | nothing | one call, one Brand |

Boundary rule: if two outputs cut from the same bytes could disagree about it, it is FramingRequest; otherwise Annotation.

### Annotation fields

- `schema`: integer, `1`. Unknown number means re-annotate.
- `hash`: 64 hex chars, sha256 of the bytes.
- `mime`: `image/jpeg | image/png | image/webp`.
- `width`, `height`: pixels, as a viewer sees the image after EXIF orientation.
- `producedBy`: `{ name, version }[]`, every Model that ran, no duplicates.
- `regions`: `Region[]`, ids assigned by contracts.

### Region fields

- `id`: `<kind>-<n>`, `n` from 1, numbered after sorting by `(kind, box.y, box.x, box.width)`. `assignRegionIds` is the one place that rule lives.
- `kind`: `face | person | vehicle`.
- `label`: the Model's own word, non-empty string.
- `box`: fractions, `x, y` in `[0, 1]`, `width, height` above 0, `x + width` and `y + height` at most 1.
- `score`: `[0, 1]`.
- `model`: `{ name, version }`, both non-empty.
- `landmarks?`: `{ rEye, lEye, nose, rMouth, lMouth }`, each a Point in fractions. Required when `kind` is `face`.
- `embedding?`: `{ model: { name, version }, vector: number[] }`. Only on `face` Regions in v1. Unit length within 1e-3.

### FramingRequest fields

- `brand`: non-empty string.
- `source`: `{ hash }`, same rule as the Annotation's hash.
- `target`: `{ width, height }` positive integers in pixels, `format?: png | jpeg | webp`, `quality?: 1..100`.
- `pinTo`: non-empty ordered list from `person | face | kart`, no duplicates. Default `["person", "face", "kart"]`.
- `persons?`: Person ids that may lead. Non-empty strings.
- `anchor?`: one of `top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right`. Default `center`.
- `subjectArea?`: a Box in Image Slot fractions.
- `occlusion`: `Box[]` in Image Slot fractions, may be empty.
- `redaction`: `{ blurUnknownFaces: boolean }`.

### Units and naming

- `Point = { x, y }` and `Box = { x, y, width, height }` are fractions, top-left origin.
- `Size = { width, height }` is pixels. Used for `target` and the Annotation's image size only.
- `center`, never `centre`, in identifiers. No `w`, `h`, `left`, `top` anywhere in contracts.
- `brand` and `personId` are plain strings.

### Versioning

- A Model's `version` changes whenever anything that can change its output changes: weights, preprocessing, class list, thresholds, runtime major. The rule is written on the field.
- `isComplete(annotation, required: ModelId[])` answers whether every required Model is in `producedBy`. A `false` is a cache miss.

### Schema library

zod 4, classic API. Types are inferred from the schemas and never written twice. Measurements and the reason in ADR-0004.

### The adapter edge

- `DecodedImage = { width, height, channels: 3, data: Uint8Array }`: raw RGB, row-major, `data.length === width * height * 3`.
- `ModelAdapter = { model: ModelId, licence: string, kinds: RegionKind[], run(image: DecodedImage): Promise<AdapterRegion[]> }`, where `AdapterRegion` is a Region without `id`.
- The models host decodes once, calls every adapter with the same `DecodedImage`, and passes the union to `assignRegionIds`.
- The gateway-to-models wire is HTTP between containers: its request is bytes or a store key, typed by `@meco/models`; its response is the contracts Annotation.

### Entry points

Two root files, per [`packages/README.md`](../../packages/README.md): `packages/contracts/index.ts` for everything a runtime module imports, `packages/contracts/conformance.ts` for the checks. The split keeps fixture handling out of the runtime graph. Implementation under `lib/`, tests under `tests/`.

### The exported surface

```ts
// packages/contracts/index.ts
export const Point, Box, Size;                      // zod; Point/Box fractions, Size pixels
export const RegionKind, ModelId, Landmarks, Embedding, Region, Annotation;
export const PinTo, CropAnchor, Redaction, Target, FramingRequest;
export const Match;
export type Point, Box, Size, RegionKind, ModelId, Landmarks, Embedding, Region,
  Annotation, PinTo, CropAnchor, Redaction, Target, FramingRequest, Match;
export const ANNOTATION_SCHEMA: 1;
export const DEFAULT_PIN_TO: PinTo[];               // ["person", "face", "kart"]
export const DEFAULT_ANCHOR: CropAnchor;            // "center"
export type DecodedImage, AdapterRegion;
export interface ModelAdapter;
export function assignRegionIds(regions: AdapterRegion[]): Region[];
export function isComplete(annotation: Annotation, required: ModelId[]): boolean;

// packages/contracts/conformance.ts
export interface Check { name: string; run(): Promise<void> }
export interface AdapterFixtures { image: DecodedImage; blank: DecodedImage }
export function adapterConformance(adapter: ModelAdapter, fixtures: AdapterFixtures): Check[];
export function schemaConformance<T>(schema: ZodType<T>, samples: { valid: T[]; invalid: unknown[] }): Check[];
```

### Conformance Checks

`adapterConformance`, each with the mutation that must turn it red:

| Check | Fails when |
|---|---|
| every region parses as `AdapterRegion` | a box with `w`, a fraction above 1, a negative score |
| every region's `model` equals the adapter's declared `model` | an adapter stamping a different version |
| every region's `kind` is in the declared `kinds` | an adapter emitting `vehicle` while declaring `[face]` |
| `licence` is non-empty text | an empty string |
| same image twice gives the same regions after rounding box, landmarks and score to 1e-4, and prints with cosine at least 0.9999 | an adapter that shuffles output or adds noise |
| the blank image gives an empty array and no throw | an adapter that throws on nothing found |
| a face region has landmarks | a face without `landmarks` |
| an embedding, when present, is unit length within 1e-3 | an un-normalised vector |

`schemaConformance`: `schema.parse(JSON.parse(JSON.stringify(x)))` deep-equals `x` for every valid sample; every invalid sample is refused.

Consumption: a package's Vitest file does `for (const c of checks) it(c.name, c.run)`. No registry; the root `pnpm test` runs every package.

### IPTC Image Region

Vocabulary borrowed, field names not. No projection function until a consumer exists.

| contracts | IPTC Image Region |
|---|---|
| `kind: face`, `kind: person` | `rCtype: human` |
| `kind: vehicle` | `rCtype: vehicle` |
| every machine Region | `rRole: subjectArea` |
| `box` | `rbShape: rectangle`, `rbUnit: relative`, `rbX rbY rbW rbH` |

## Testing decisions

- Tests cross the package entry points and nothing else, enforced by dependency-cruiser.
- contracts tests its own schemas through `schemaConformance` with valid and named invalid samples, `assignRegionIds` with shuffled input, `isComplete` with a missing version, and `adapterConformance` against an in-memory fake adapter plus one deliberately broken fake per check.
- Every check is proved able to fail before it ships. The ticket names the mutation.
- No image library, no network, no store in any contracts test.

## Out of scope

- Code that touches pixels, fetches, stores or renders.
- Per-consumer models, an IPTC projection, human-drawn Regions, redaction beyond `blurUnknownFaces`.
- Retention of Face Prints in stored Annotations: raised on [The records schema (#76)](https://github.com/timschoch/meco/issues/76).
- The gateway's HTTP and MCP input types, which hold URLs and template ids and belong to the gateway.

## Further notes

`SubjectBox` and `SubjectArea` from the prototype's solver are frame's internal types and not in contracts; only the Subject Area on the FramingRequest is.
