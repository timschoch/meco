# meco

## Agent skills

### Issue tracker

GitHub Issues on `timschoch/meco`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Tests

No test framework, and do not add one. A test is a `tsx` script that prints its
checks and sets `process.exitCode = 1` on failure, wired as an npm script.
`scripts/verify.ts`, `scripts/http-probe.ts` and `scripts/mcp-probe.ts` are the
models.

Full gate:

```
pnpm typecheck && pnpm typecheck:faces && pnpm build && pnpm build:faces \
  && pnpm test:crop && pnpm test:http && pnpm test:mcp && pnpm test:ui \
  && pnpm test:detect && pnpm test:embed && pnpm test:objects && pnpm test:match
```

`pnpm test:storage` runs against the live Blob store: it needs `.env.local`
and takes ~10 minutes. It is not part of the gate. Neither is
`pnpm --filter meco-faces verify:dfine`, which re-checks the committed object
model against its source over the network — see `DEPLOY.md`.

**Prove a test can fail.** Mutate the code it covers and confirm the suite
catches it. Three tickets in the Subject-aware Crop feature did this; two found
real bugs that way, and one found a cascade-delete test that passed against a
version leaving personal data in the store.

## Docs

Vocabulary lands with the feature, not in a later sweep: a change that
introduces a term adds it to `CONTEXT.md` in the same PR. Merged code and
`CONTEXT.md` outrank a plan document — where a plan's shorthand and the shipped
types disagree, the types win and the ADR records why.

## Deployment configuration

Two container services in one Vercel project. `DEPLOY.md` is the source of
truth; the traps that cost failed builds are written there with the verbatim
error strings. Two env vars gate shipped features and are owner-set:
`FACES_URL` (without it no Crop is framed on a face) and
`BLOB_PEOPLE_READ_WRITE_TOKEN` (without it every write under `people/` is
refused).

---

# The modular rebuild

Target architecture. One module, one job, done well. Deep modules: a lot of
behaviour behind a small interface at a clean seam. Every module is also an
agent-callable tool — usable in the flow or alone.

## Modules

| Module | Its one job |
|---|---|
| `store` | bytes by key, public or private |
| `records` | everything known about a file, in a DB |
| `models` | run named models over an image, return labelled regions |
| `identify` | say who or what a region is |
| `frame` | choose the crop window — pure maths, no pixels |
| `redact` | hide what must not be shown |
| `compose` | lay out a template, emit its occlusion zones |
| `gateway` | one endpoint: auth, quota, pricing, routing |
| `webui` | gallery and what-happened view. Second-class citizen |

`models` is a **catalogue**, not a face service. Shared models only for now;
per-consumer models are the direction, not the first step.

**One adapter per model, hand-written.** Do not generalise the middle — it
cannot be. Standardise only the edges: same input in, same output out.

- Input: the host decodes **once** and passes the decoded image to every
  adapter. Decode costs more than inference (31 ms vs 28 ms, `DEPLOY.md`).
- Output: `SubjectBox` in fractions, `width`/`height` never `w`/`h` (ADR-0002).
- Every adapter passes the same conformance suite, whatever it detects.
- Licence text ships with the adapter, so a model cannot be added without one.

## Two data types. Never merge them.

- **Annotation** — facts about the image. Keyed by content hash, cached
  forever, shared by every module.
- **FramingRequest** — facts about this output. Occlusion zones, target size,
  pin-to, redaction policy. Never cached.

**The Annotation may only hold what is true of the bytes.** Anything brand- or
template-dependent poisons the cache: #11 gave no face the `mainSubjectArea`
role for exactly this reason.

Image information lives **beside** the file, never inside it. Writing metadata
into the file changes the bytes, which changes the hash, which invalidates the
key it was filed under.

Modules are seams, not containers. Deploy as few services as the work needs.

## Building a module

One owning agent per module. The orchestrator hands it a **one-paragraph
brief** — what the module is for, no technical detail — and the agent runs
every step below, in order. Skipping a step is a defect.

Steps 1–7 stay in **one unbroken context window**. Do not `/compact` or
`/clear` before step 7.

1. **Orient.** Read `CONTEXT.md`, `docs/adr/`, and the architecture ADR. Read
   the **entry points** of every module yours touches — never their internals.
   That is what the seam is for.
2. **`/grill-with-docs`.** Interview until the concept is sharp. You have no
   human: **the orchestrator answers**. Message it and wait. Facts are yours to
   establish; decisions are the orchestrator's. Leaves the trail in
   `CONTEXT.md` and ADRs.
3. **`/domain-modeling`.** Every new term for your module lands in
   `CONTEXT.md` with its avoid-list, in the same PR as the code. A term that
   already exists is not redefined.
4. **`/codebase-design`.** Settle the shape before any code: what the interface
   is, where the seam goes, how deep it is. Write the interface down first.
5. **`/prototype`.** Only when a design question needs a runnable answer.
   `/handoff` out and back.
6. **`/to-spec`.** Collapse the thread into a spec.
7. **`/to-tickets`.** Tracer-bullet tickets as GitHub sub-issues of your
   module's parent issue, each declaring its blocking edges.
8. **Agree the seams.** Post the seams you will test at to your parent issue
   and wait for the orchestrator's confirmation. `/tdd` forbids a test at an
   unconfirmed seam.
9. **`/implement`** per ticket, **`/clear` between each**. It drives `/tdd`
   internally — one red-green vertical slice at a time — and closes with
   `/code-review` on both axes.
10. **Conformance.** Run the cross-module conformance suite. Prove every new
    check can fail by mutating the code it covers.
11. **Report** to the orchestrator: PR, what you proved, what you could not.

## Rules that hold throughout

- **Verify against the running system, not only the suite.** Every serious bug
  in the last build was found by calling the live API by hand.
- **Review verdicts are input, not orders.** A finding that does not survive
  measurement gets refused, with the measurement.
- **Numbers carry provenance.** Say what was measured, on what, at what size.
  A number without it is a trap.
- **Deviating from a ticket is allowed; doing it silently is not.** Put the
  deviation and its reason in the PR body.

## The orchestrator

Read-only on `src/`. Never writes a module. Its job: hand out briefs, answer
questions, confirm seams, relay review verdicts, own merge order, keep the
product aligned, and verify against production between phases.
