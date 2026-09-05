# ADR-0007 — models: one route, a two-stage Catalogue, and a thin client the gateway may import

Status: **accepted, 6 Sep 2026**. Numbered 0007 by the orchestrator: five design branches claimed 0006 at once. Parent: [Module: models (#83)](https://github.com/timschoch/meco/issues/83). Settles [The models adapter contract and its conformance suite (#75)](https://github.com/timschoch/meco/issues/75). Spec: [`../specs/models.md`](../specs/models.md). Builds on [ADR-0002](0002-meco-faces-as-a-separate-service.md) (geometry out, policy elsewhere), [ADR-0004](0004-packages-with-enforced-entry-points.md) (root files are the interface) and [ADR-0005](0005-contracts-annotation-framingrequest-and-zod.md) (the adapter edge is contracts', the wire is models'). Decided by the orchestrator with the models agent, the owner away; the grilling is ledgered on #75.

## Context

The prototype's face service had three routes, one per network, each decoding the image again and each with its own response shape; meco bounded the image before sending because a Vercel Function refuses a 4.5 MB body, so the service never saw the caller's bytes. Contracts now fixes the Annotation and the adapter edge (`DecodedImage` in, `AdapterRegion[]` out). What is left to decide is the wire, the shape of the Catalogue, and how the gateway reaches it without the two containers sharing code.

## Decision 1 — one route, the caller's bytes, the hash of what arrived

`POST /annotate?models=…` takes the Source Image's bytes and answers with the contracts Annotation. The host hashes the body it received and never re-encodes before hashing, so the Annotation's `hash` is the gateway's cache key by construction. No store key on the wire: it would put a store token in the container that must hold no credential. The one thing that reopens this is a measurement: if a service-binding call is subject to the platform's 4.5 MB body limit, a `{ key }` body is the escape hatch. The first ticket measures it on the deployed container and records the answer in the spec.

## Decision 2 — Detectors and Enrichers, two stages, one Catalogue

Contracts' `ModelAdapter.run(image)` fits a network that draws boxes. EdgeFace draws none: it takes the landmarks YuNet found and attaches a Face Print to a Region that already exists. Forcing it through `run(image)` would either hide two networks and two versions behind one `model` id, or widen the contracts edge for every detector to serve one enricher. So the Catalogue has two roles. A **Detector** is contracts' `ModelAdapter`. An **Enricher** is models' own interface: same `model`, `licence` and conformance discipline, but `run(image, regions)` returning the same Regions with more on them. The host runs Detectors, then Enrichers, then contracts' `assignRegionIds`. `producedBy` lists both roles. Contracts stays untouched, and `adapterConformance` keeps its promise that every Detector passes the same suite.

## Decision 3 — the gateway imports one thin client file

`packages/README.md` forbids `gateway` importing `models`, so that the two containers never share server code. The wire still needs one owner, and ADR-0005 put it in models. The rule is reshaped, not dropped: the gateway may import `packages/models/index.ts` alone, and a second rule forbids that file from importing `onnxruntime-node`, `sharp` or any host module. The client carries the request schema, parses the response with contracts' `Annotation`, and turns wire errors into typed ones. The alternative, a hand-written fetch in the gateway, would make the wire's shape live in two packages and drift.

## Decision 4 — decode once at the Decode Bound; the Annotation describes the photograph

One sharp decode per request: EXIF-rotated, bounded to a 1600 px long edge, never enlarged, raw RGB. Every adapter resizes from that buffer. 1600 because the prototype measured it (group fixture 5878x7348, `DEPLOY.md` history, 5 Sep 2026): boxes move under 0.002 at any cap down to 640, the smallest face is ~100 px at 1600 so the print moves (0.96 cosine) but identity does not (same-person 0.7146 → 0.7117, different-person 0.2985 → 0.2979), and ADR-0003's threshold was calibrated at this size. `width` and `height` come from the metadata, not the buffer, so a fraction of a Region is a fraction of the photograph the caller has.

## Decision 5 — glibc image, telemetry off, warm after listening

onnxruntime-node 1.29 ships no musl binary, so the models image is `node:24-slim`, not the skeleton's alpine. Its Linux binary carries POSIX telemetry (1.29.0 release notes; the container logs a CA-bundle warning at session create), so `ORT_DISABLE_TELEMETRY=1` is set in the image: a container that holds photographs uploads nothing. Sessions are created after the socket opens, one after another in Catalogue order; `/health` reports Warm per instance.

Measured 6 Sep 2026 in `.temp/ort-proto`, Docker Desktop on Apple silicon, `node:24-slim` arm64, ORT 1.29.0, `--cpus=1 --memory=2g`: session create yunet 386 ms, edgeface 304 ms, dfine 828 ms; RSS 65 MB at start, 148 MB with three sessions, 237 MB after one inference each. The inference timings from that run are not carried: they vary 3x with the Docker CPU quota and are not the platform's. The deployed container is the measurement that counts, and ticket 1 takes it.

## Considered and rejected

- **Three routes as the prototype** (`/detect`, `/embed`, `/objects`). Three decodes, three response shapes, a new route per model. Already out by the greenfield rule in `CLAUDE.md`.
- **A store key in v1.** A credential in the container and a second code path before a measurement says the first one fails.
- **One `faces` adapter wrapping YuNet and EdgeFace.** Two networks behind one version; a weights swap in one would invalidate cached prints of the other.
- **Widening contracts' `run(image, prior?)`.** Every detector would carry an argument it ignores.
- **A shared token between the containers.** Both read the same project-level env; it adds a moving part and no wall the private network does not already give.
- **Weights in Git LFS.** 23 MB in three files that change rarely; LFS is a second fetch path on the build.

## Not decided here

- Whether the 4.5 MB body limit reaches a binding call (ticket 1 measures).
- Memory and CPU sizing beyond the platform default (ticket 1 measures `rss` and `Server-Timing` on the deployed container).
- The `Detected Object` and `Kart Producer` entries in `CONTEXT.md`, prototype terms that the contracts section's Region and Label now cover; proposed for removal to the orchestrator.
