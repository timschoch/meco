# ADR-0005 — The contracts package: three shared types, zod 4, and a conformance suite that imports no test runner

Status: **accepted, 6 Sep 2026**. Parent: [Module: contracts (#80)](https://github.com/timschoch/meco/issues/80). Settles [What belongs in an Annotation (#69)](https://github.com/timschoch/meco/issues/69) and [What belongs in a FramingRequest (#70)](https://github.com/timschoch/meco/issues/70). Spec: [`../specs/contracts.md`](../specs/contracts.md). Builds on [ADR-0001](0001-analytic-solver-over-search-based-crop.md) (fractions, `width`/`height`), [ADR-0002](0002-meco-faces-as-a-separate-service.md) (framing policy lives outside the detector) and [ADR-0003](0003-face-recognition-licence-consent-and-threshold.md) (a Face Print carries no model tag, which this ADR closes).

## Context

Nine modules are built by nine agents in parallel. Each needs the same three answers: what an image analysis is, what one output asks for, and how a detector proves it emits the shared shape. The prototype answered the first with IPTC's JSON serialisation plus `meco:` extensions, kept the second implicit in a `CropRequest` that also held pixels, and had no third answer at all. Decided by the orchestrator with the contracts agent, the owner away; the grilling is ledgered on #69 and #70.

## Decision 1 — three types, one boundary rule

`@meco/contracts` owns **Annotation**, **FramingRequest** and **Match**. Field lists and reasons are in the spec; the rule that assigns a fact to one of them is here because it outlives any field:

> If two outputs cut from the same bytes could disagree about it, it is FramingRequest. Otherwise Annotation. If it is true only for one Brand on one call, it is a Match.

Consequences that follow from the rule and are easy to get wrong:

- **No timestamp in the Annotation.** When the regions were found is not true of the bytes. `records` keeps row time.
- **No template, no URL in the FramingRequest.** compose consumes the template and emits Occlusion Zones and a Subject Area; the gateway resolves a URL to a Content Hash. `frame` therefore never learns about templates or fetching.
- **`kart` is not a Region Kind.** "A motorbike and the person on it are one Subject" is framing policy (ADR-0002). A Region carries meco's closed `kind` (`face | person | vehicle`) and the model's open `label` (`motorbike`), and `frame` composes the kart.
- **A Face Print rides on its face Region with its own `{ name, version }`.** The box comes from one network and the print from another, so one `model` per Region cannot name both. ADR-0003 recorded that a stored print carried no model tag and that a model swap would silently invalidate every print; the tag now travels with the print and the swap becomes a cache miss.
- **Match is Brand-scoped and never enters the Annotation.** The same face is a Match for the Brand that enrolled the Person and unknown to every other. The threshold and margin stay in `identify`.

## Decision 2 — ids by geometry, versions by rule, schema by integer

- **Region ids are `<kind>-<n>`, numbered after sorting by `(kind, box.y, box.x, box.width)`.** identify keys on `(hash, regionId, brand)`, so two runs of the same model version over the same bytes must give the same ids. Sorting makes that true by construction; adapter output order would make it true by accident.
- **A Model's `version` changes whenever anything that can change its output changes**: weights, preprocessing, class list, thresholds, ONNX runtime major. The Annotation's `producedBy` lists every `{ name, version }` that ran; a consumer names what it requires, and a missing entry is a cache miss. The prototype got the same effect by folding the class list into the producer string. The rule is now on the field, where the next adapter author reads it.
- **`schema: 1` on the Annotation.** A reader that meets a number it does not know re-annotates. There is no migration path and there will not be one: detection is cheaper than a migration that has to be right about every stored row.

## Decision 3 — zod 4, classic API

Measured 6 Sep 2026 in `.temp/schema-bench` on this machine (Node 26.7.0, pnpm 11.0.8, esbuild 0.28.2; zod 4.5.4, valibot 1.4.2, arktype 2.2.3, effect 3.22.1, `@modelcontextprotocol/server` 2.0.0):

| | zod | zod/mini | valibot | arktype | effect Schema |
|---|---|---|---|---|---|
| one nested schema + a parse, esbuild min, gzip -9 | 87.0 KB | 5.3 KB | 1.7 KB | 47.0 KB | 97.1 KB |
| 100k parses of a 1 KB object, best of 3 | 6.1 ms | 32.6 ms | 32.8 ms | 1.0 ms | 50.4 ms |
| installed size | 7.7 MB | same | 1.8 MB | 1.6 MB with deps | 33 MB |
| Standard Schema (`~standard`) | yes | yes | yes | **no** | yes |
| JSON Schema | `z.toJSONSchema` | same | separate package | `.toJsonSchema()` | `JSONSchema.make` |
| Hono validator | `@hono/zod-validator` | same | `@hono/valibot-validator` | `@hono/arktype-validator` | `@hono/effect-validator` |

The deciding fact is not in the numbers. `@modelcontextprotocol/server` 2.0.0 depends on `zod ^4.2` itself, and its `registerTool` accepts either a zod raw shape or a Standard Schema object that also carries JSON Schema. zod is the one candidate where the contract schema, the MCP tool input schema and the Hono validator are the same object. Bundle size is not a criterion for two server containers. arktype's 6x speed lead is on a 6 ms baseline per 100k parses and it lacks Standard Schema, so the gateway would convert on every tool registration. The microbenchmark covers one shape; unions and refinements would move it, and nothing here depends on it.

zod is therefore the one runtime dependency of `@meco/contracts`. "Depends on nothing" means no meco package.

## Decision 4 — the adapter edge lives in contracts, the wire does not

`CLAUDE.md` standardises only the adapter's edges. Those two types, `DecodedImage` (raw RGB, decoded once by the host) and `ModelAdapter` (model, licence, kinds, `run`), are in contracts, because the conformance suite that every adapter passes has to name them and the suite is contracts'. Everything host-side stays with `models`: decode, the size bound, the catalogue, warmth. The gateway-to-models wire is HTTP between containers, so its request is bytes or a store key and never a `DecodedImage`; that request type is `models`' own and the response is the contracts Annotation.

## Decision 5 — conformance checks are data, not tests

contracts exports `Check = { name, run(): Promise<void> }` and functions that return `Check[]`. A module maps them onto its own Vitest file. contracts imports no test runner: the alternative, exporting `describe` blocks, would make vitest a peer dependency of the package that every runtime module imports.

Determinism is checked to a tolerance, not to the byte: same image twice gives the same regions after rounding box, landmarks and score to 1e-4, and prints with cosine similarity at least 0.9999. Byte equality would fail on any runtime with non-deterministic float kernels and teach nothing when it did.

Every check ships with a named mutation that must turn it red. A check that cannot fail is not shipped.

## Considered and rejected

- **IPTC's JSON shape as the stored shape** (the prototype). Nothing consumes an IPTC export and nothing may be written into a file. The vocabulary is borrowed where it fits (`kind` maps to `rCtype`, boxes are `rbUnit: relative` rectangles); the field names are not. The mapping is a table in the spec and a projection function waits for a consumer.
- **`kart` as a Region Kind.** It would put a framing decision in a cache shared by every Brand and every template.
- **A URL in `source`.** It would make `frame` and `records` aware of fetching.
- **Byte-equal determinism.** See Decision 5.
- **Branded string types for `brand` and `personId`.** Nothing in v1 would catch a swap that the schema does not.

## Not decided here

- Retention of a Face Print for a stranger, cached forever under the Content Hash. Posted on [The records schema (#76)](https://github.com/timschoch/meco/issues/76).
- Human-drawn Regions, per-consumer models, redaction beyond `blurUnknownFaces`, an IPTC projection.
