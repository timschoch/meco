# ADR-0002 — meco-faces as a separate service

Status: **accepted, 4 Sep 2026**. Research: [`../research/subject-aware-cropping.md`](../research/subject-aware-cropping.md). Plan: [`../plans/faces-and-subject-aware-crop.md`](../plans/faces-and-subject-aware-crop.md) phase 2. Builds on [ADR-0001](0001-analytic-solver-over-search-based-crop.md), which made a detected face one producer of Subject Boxes among several.

## Context

The solver wants faces. Getting them means ONNX Runtime, a model file and a session that has to be created before the first answer — about 116 MB of dependency and a load meco has no other use for.

meco is a scale-to-zero container. It boots for a `list_templates` call, for the console's first page, for every MCP exchange. Every one of those boots would carry the face stack if the face stack lived in meco's image, and almost none of them would ask for a face.

The detector is also the part most likely to be replaced. YuNet is a 230 KB MIT model chosen on licence as much as accuracy; a better one under an acceptable licence is a plausible upgrade, and so is a hosted API. What must not move when that happens is meco's own API.

## Decision

Face ML runs in **its own container image and its own service**, `meco-faces`, with two routes — `POST /detect` and `GET /health` — and no state at all.

- **In: image bytes. Out: JSON.** It never reads Blob, never knows a Person, holds no secret but `MECO_TOKEN`, and returns every number as a fraction of the image so nothing it says depends on a resolution.
- **meco stays the only public API.** meco calls meco-faces; nobody else does.
- **Both services live in one Vercel project**, declared as two entries under `services` in `vercel.json` and separated by a rewrite: `/faces/(.*)` to `meco-faces`, `/(.*)` to `meco`. This closes the plan's open question 2, on a preview deployment rather than on the documentation: both services build, and `GET /faces/health` returns the model and the ONNX Runtime version while `GET /health` still answers from meco. The fallback of a second project with a `FACES_URL` env var is not needed.
- **The rewrite passes the path through unchanged** — the deployment proves it, since `/faces/health` reaches the faces container still wearing the prefix. The faces app therefore mounts its routes at both `/` and `/faces`, and answers the same way behind the rewrite, behind a second project, or under plain `docker run`.

## Consequences

- **meco's cold start is unchanged.** The face stack is only ever loaded by a container that was started to find a face. Measured: meco-faces answers a 12 MP photo 480 ms after `docker run`, 45 ms warm — see [`../../DEPLOY.md`](../../DEPLOY.md).
- **Two images to build and keep green**, and a second `pnpm` workspace package. `pnpm deploy` is what keeps meco's own dependencies — takumi, react, pdf-lib — out of an image that renders nothing.
- **A network hop per detection**, inside one project. The cost is bounded by the rule that every Source Image is analysed once and the Annotation is cached under the image's hash.
- **The detector is replaceable behind two endpoints.** A different model, or a hosted API, is a change to one service and no change to meco.
- **One token, two services.** `MECO_TOKEN` is set on both. `/detect` requires it; `/health` does not, because a liveness probe that needs a secret cannot be used by the platform deciding whether the container is alive.
- **The faces image is built from a root-level `Containerfile`**, which is the only name left once two Vercel constraints are applied: a service `entrypoint` must have the basename of a Dockerfile or a Containerfile, and the build context is the entrypoint's own directory rather than the service `root`, so the file cannot sit beside the package it builds — the install needs the workspace lockfile at the repository root. `Dockerfile.vercel` is meco's. Both constraints cost a failed deployment each to find; they are written down in [`../../DEPLOY.md`](../../DEPLOY.md).
- **`vercel.json` rewrites are ordered**, and meco's `/(.*)` catches everything. The faces rule has to stay above it, and anything meco ever serves under `/faces` would now be shadowed.
- **The detect knobs stayed out.** `/detect` takes an image and nothing else: no score or NMS threshold in the query string. The defaults are the ones the fixtures are calibrated against, and a tunable surface on a route only meco calls is a promise with no one to keep it.
- **A single project means a single deployment.** A change to either service redeploys both, and neither can be rolled back on its own. Splitting them later is a `vercel.json` edit plus a `FACES_URL` env var, which is why meco reaches the service by configuration rather than by a hardcoded path.
