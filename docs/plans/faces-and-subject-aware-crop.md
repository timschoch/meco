# Plan — subject-aware Crop, face service, People, face blur

Status: **proposed, 4 Sep 2026**. Research: [`../research/subject-aware-cropping.md`](../research/subject-aware-cropping.md). Vocabulary: [`../../CONTEXT.md`](../../CONTEXT.md).

## Decisions taken (owner: Tim)

- EdgeFace `edgeface_xs_gamma_06` is the face-recognition model. The CC BY-NC-SA weight licence on the Hugging Face model cards is accepted as an MVP risk. Record as ADR-0003 before v3 ships. Do not enrol third parties' faces before consent exists.
- Face ML runs in **its own container image and service** ("meco-faces"). meco stays the only public API; meco calls meco-faces.
- People belong to a **Brand** (the "consumer" in CONTEXT.md). A Person has many Reference Photos.
- A Crop can **blur every face that is not a matched Person**.

## New vocabulary (add to `CONTEXT.md` under "Photos and cropping" when built)

| Term                | Meaning                                                                                                                                                                                          | Avoid                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| **Subject Box**     | One rectangle in a Source Image, fractions 0..1, with a priority and a `keep` flag. Every producer (Crop Anchor, saliency, face, Person, object) yields Subject Boxes. The solver consumes them. | region, bbox, focal point       |
| **Person**          | A named individual a Brand wants recognised. Owned by exactly one Brand.                                                                                                                         | identity, user, contact         |
| **Reference Photo** | A Source Image enrolled for one Person, containing that Person's face. Several per Person.                                                                                                       | training image, sample, example |
| **Face Print**      | The 512-float EdgeFace embedding of one face. A Person has one Face Print per Reference Photo. Never a photo.                                                                                    | embedding, descriptor, template |
| **Match**           | A detected face whose best Face Print similarity clears the threshold and the runner-up margin. Open-set: "no Match" is a valid answer.                                                          | recognition hit                 |
| **Face Blur**       | A Crop option: every detected face that is not a Match is blurred.                                                                                                                               | anonymise, pixelate             |
| **Annotation**      | The stored Subject Boxes for one Source Image, keyed by content hash, IPTC Image Region shaped. Machine regions and human override regions are separate entries.                                 | metadata, tags                  |

## Architecture

```
client ──HTTP/MCP──▶ meco (existing container)
                       │  solver, storage, People, Face Blur, UI
                       │
                       └─HTTP + MECO_TOKEN──▶ meco-faces (new container)
                                               YuNet detect · EdgeFace embed
                                               stateless, no storage, no secrets but the token
```

Rules:

- **meco-faces is pure compute.** In: image bytes. Out: JSON. It never reads Blob, never knows a Person. Replaceable by any other detector behind the same two endpoints.
- **meco owns all state**: Persons, Face Prints, Annotations, Crops. Cosine matching is 50×512 floats. It lives in meco, not in the ML service.
- **Every Source Image is analysed once.** meco hashes the bytes, looks up `annotations/<sha256>.json`, and only calls meco-faces on a miss. Repeat Crops of one photo at ten Placements cost one detection.
- **Deploy**: second entry in `vercel.json` `services` (`meco-faces`, `Dockerfile.faces`), reached at `/faces/*` by rewrite, or its own Vercel project if one project cannot hold two container services. Verify in step 3; the plan works either way. Same `MECO_TOKEN` env var on both.

## API

### meco-faces (internal)

| Route          | Body                                                           | Returns                                                                                                                   |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `POST /detect` | image bytes (`image/*`)                                        | `{ width, height, faces: [{ box:{x,y,w,h}, landmarks:{rEye,lEye,nose,rMouth,lMouth}, score }] }` — fractions of the image |
| `POST /embed`  | image bytes + `?faces=<json>` (boxes+landmarks from `/detect`) | `{ prints: [[512 floats]] }` — aligned with `sharp.affine()`, EdgeFace on ORT                                             |
| `GET /health`  |                                                                | models loaded, ORT version                                                                                                |

Pipeline inside: sharp decode → raw RGB → YuNet (ORT, 640 long side) → decode + NMS → 5-point similarity warp to 112×112 via `sharp.affine()` → EdgeFace → L2-normalise.

### meco (public, `/v1/*`, existing auth)

| Route                                   | Purpose                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/people?brand=`                 | list Persons of a Brand with photo count                                                                                                                                  |
| `POST /v1/people`                       | `{ brand, name }` → Person id                                                                                                                                             |
| `DELETE /v1/people/:id`                 | remove Person, all Reference Photos and Face Prints                                                                                                                       |
| `POST /v1/people/:id/photos`            | multipart or `{ source: url }`. Detects faces. One face: enrol. Several: return faces, caller picks with `faceIndex`. Stores photo + Face Print.                          |
| `DELETE /v1/people/:id/photos/:photoId` | remove one Reference Photo and its Face Print                                                                                                                             |
| `POST /v1/subjects`                     | `{ source }` → the Annotation for that Source Image (detect, match against the Brand's Persons if `brand` given). Cached by hash. Lets the UI show boxes before cropping. |
| `POST /v1/crop`                         | extended, see below                                                                                                                                                       |

`cropBody` additions:

```ts
brand?: string          // enables Person matching against that Brand's People
pinTo?: "person" | "faces" | "attention"   // producer preference; default "person" when brand given, else "faces", else "attention"
persons?: string[]      // limit the Match to these Person ids
blurUnknownFaces?: boolean   // Face Blur; default false
subjectArea?: { x, y, width, height }   // fractions of the output; default = golden-ratio grid
```

`CropResult` additions: `resolvedBy: "override" | "person" | "face" | "saliency" | "anchor" | "centre"`, `subjects: SubjectBox[]`, `matches: [{personId, name, score}]`, `blurred: number`, `subjectAreaSatisfied: boolean`.

MCP: mirror `crop_image` changes and add `list_people`, `add_person`, `add_reference_photo`, `find_subjects` in `src/mcp.ts`.

## Storage

Extend `Storage` with `get(key): Promise<Buffer | null>` and `putAt(key, data, contentType)` (fixed key, overwrite) and `delete(key)`. Both backends. Keys:

```
people/<brand>/<personId>/person.json         { id, name, brand, createdAt, photos:[{photoId, key, printKey, enrolledAt}] }
people/<brand>/<personId>/<sha>.jpg           Reference Photo (public Blob today — see Open questions)
people/<brand>/<personId>/<sha>.print.json    Face Print, 512 floats, model tag
annotations/<sha256-of-source>.json           Annotation, IPTC Image Region shape (research Q7)
```

Gallery: `people/` is **not** listed by `/v1/gallery`. It is not a stored output.

## Solver (`src/crop.ts`)

Implement research Q6 verbatim:

1. Collect Subject Boxes from producers in order: override → Person Match → detected faces → saliency point (`sharp` `attentionX/Y`) → Crop Anchor → centre.
2. Anchor point: top-tier box alone if a Person matched; else priority×area weighted centroid.
3. Window: cover size for the aspect; solved zoom when `subjectArea` is given.
4. Target: nearest phi line; faces put the **eye line** (YuNet eye midpoint) on the upper phi line.
5. Solve, clamp, containment check, fallbacks in order: zoom out → relax to centre → drop lowest `keep` → clip and report.
6. Face Blur: after the window is known, for each detected face with `keep=false` inside the window: `extract` → `blur(σ = 0.25·faceWidthPx)` → `composite` back with an elliptical mask. Then encode.

Pure function `solveCrop(boxes, source{w,h}, target{w,h}, opts) → {left, top, width, height, resolvedBy, satisfied}`. No sharp inside. Unit-tested.

## Faces console (`src/ui.ts`)

New tab **People**:

- Brand select → list of Persons as cards: name, Reference Photo thumbnails with the enrolled face outlined, photo count, delete.
- "Add person": name → creates. "Add photo": file input (multiple) or URL. After upload the card shows detected faces as outlined boxes; when more than one, click the right face to enrol. Rejected: no face found, face too small (<40 px), duplicate print.
- Consent line under the form: enrol only people who agreed, embeddings are stored, delete removes everything.

Crop tab additions:

- Brand select (optional). "Pin to" select: a Person of that Brand, any known person, faces, attention. "Blur unknown faces" checkbox. "Preview subjects" button calls `/v1/subjects` and draws boxes over the Source Image on a canvas, matched faces green with the name, unknown faces grey.
- Result card shows `resolvedBy`, matches, blurred count.

Style: same `el()`/`field()`/`card()` helpers, same tokens. No framework.

## Container

`Dockerfile.faces`:

```
node:24-slim → pnpm install --frozen-lockfile --filter meco-faces
onnxruntime-node pruned to linux/x64 (~45 MB)
models/ copied: face_detection_yunet_2026may.onnx (230 KB), edgeface_xs_gamma_06.onnx (~7 MB, exported once, checked in under models/ with its export script)
node dist/faces/server.js, PORT from env
```

Workspace: `pnpm-workspace.yaml` gains `packages/faces`. Shared code (nothing at first) stays in meco. The model export script (`packages/faces/scripts/export-edgeface.py`, torch + the otroshi/edgeface checkpoint) runs on a laptop and commits the `.onnx`. Pin the checkpoint commit SHA.

Cold start budget: measure ORT session create for both models. Target < 1.5 s cold, < 300 ms warm per 12 MP photo. If cold start dominates, set `min instances` on the faces service or keep the session in module scope (it is; Fluid Compute reuses).

## Phases and steps

### Phase 1 — solver + saliency, meco only (no new service)

1. `src/crop.ts`: `SubjectBox`, `solveCrop`, producers for anchor/saliency/centre, read `attentionX/Y` from a 32-px probe resize. Keep `anchor`/`strategy` inputs working; `strategy: "attention"` now means "saliency producer".
2. `subjectArea` input on `/v1/crop`; extend `resolvedBy`.
3. Tests: `scripts/crop-solver-test.ts` with fixtures; golden-ratio placement asserted numerically. Compare output URLs for the demo photos on `main` vs branch.
4. CONTEXT.md: add Subject Box. ADR-0001: analytic solver over search-based crop.

### Phase 2 — meco-faces service + face producer + Face Blur

5. `packages/faces`: Hono server, ORT, YuNet decode (~150 lines), `/detect`, `/health`. `Dockerfile.faces`. Local run via docker.
6. `vercel.json`: second service + `/faces/*` rewrite. Verify two container services in one project deploy; else create project `meco-faces` and set `FACES_URL` in meco. ADR-0002: separate service.
7. meco: `src/faces.ts` client (`detect`, `embed`), `src/annotations.ts` (hash, cache in storage), face producer with eye-line headroom, `blurUnknownFaces` (blurs all faces in this phase, since no Persons exist yet).
8. UI: "Preview subjects" overlay, blur checkbox. `pnpm test:ui` extended.
9. Measure latency cold/warm in the deployed container; record in DEPLOY.md.

### Phase 3 — People and Matches

10. Export EdgeFace to ONNX, commit `models/edgeface_xs_gamma_06.onnx` + script. `/embed` with `sharp.affine()` alignment. Verify against the PyTorch output on 3 faces (cosine > 0.99).
11. Storage `get`/`putAt`/`delete`; `src/people.ts`: CRUD, enrol (detect → pick → embed → store), match (cosine, threshold + margin, open-set). Threshold calibrated on Tim's own photos: sweep, pick where no stranger crosses, add margin. Record the number in the ADR.
12. `/v1/people*`, `/v1/subjects` with matching, `pinTo`/`persons` on crop, MCP tools.
13. UI People tab and Crop "Pin to" select.
14. ADR-0003: EdgeFace licence acceptance and consent rule. DEPLOY.md: People data is personal data; deletion path; no Reference Photo on a public URL without consent (see Open questions).

### Later, not in this plan

Kart detector (D-FINE-N) and driver's head (RTMPose-t) as further producers on meco-faces. Same service, two more models. Research Q5.

## Verification gates (each phase)

- `pnpm typecheck`, `pnpm build`, docker build of every image.
- `pnpm test:mcp` still exits 0 (no MCP stream left open).
- Crop of the same Source Image at 1:1, 4:5, 9:16, 16:9: the Subject centre lies on a phi line ±2 % or the result reports the fallback taken.
- Group photo with Tim enrolled: crop pins on Tim, other faces blurred when asked, `matches` names Tim only.
- Photo with no known face: `resolvedBy` is `face`, then `saliency` when no face.
- Container image sizes and cold-start numbers written to DEPLOY.md.

## Open questions

1. **Reference Photos on public Blob.** The Blob store is public. A Reference Photo is a face photo of a named person. Options: private Blob store for `people/` (Vercel Blob supports private), or keep only the Face Print and a small blurred thumbnail. Recommendation: private store, `people/` only.
2. **Two container services in one Vercel project** — unverified. Fallback is a second project.
3. **Match threshold** — no published number for EdgeFace. Calibrate in step 11.
4. **Consent UX** — a checkbox at enrol time, or a rule in DEPLOY.md only. Recommendation: checkbox, stored as `consentAt` on the photo record.
5. **Upload path** — meco takes URLs today. Reference Photos need real upload (multipart). Hono handles `c.req.parseBody()`. Body limit on Vercel is 100 MB, fine.
