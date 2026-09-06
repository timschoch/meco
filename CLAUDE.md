# meco

## Agent skills

### Issue tracker

GitHub Issues on `timschoch/meco`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Packages

Packages are deep modules: their only public surface is their root files. See
[packages/README.md](./packages/README.md) before adding or importing one.

## Tests

Vitest, in workspace mode from the repo root. A package's tests live in its own
`tests/` folder and reach it through its entry points, like every other caller.

Full gate: `pnpm check` — typecheck, `lint:boundaries`, tests. CI
(`.github/workflows/ci.yml`) runs the same three plus `pnpm build`.

**Prove a test can fail.** Mutate the code it covers and confirm the suite
catches it. Three tickets in the Subject-aware Crop feature did this; two found
real bugs that way, and one found a cascade-delete test that passed against a
version leaving personal data in the store.

**Commit the green state before you mutate**, then undo the mutation with
`git restore`. Restoring a directory to undo a mutation wipes every uncommitted
change in it, which is how one implementer lost its own work twice.

## Docs

Vocabulary lands with the feature, not in a later sweep: a change that
introduces a term adds it to `CONTEXT.md` in the same PR. Merged code and
`CONTEXT.md` outrank a plan document — where a plan's shorthand and the shipped
types disagree, the types win and the ADR records why.

## Deployment configuration

Two container services, `gateway` and `models`, and one Node Function, `front`,
in one Vercel project.
`DEPLOY.md` is the source of truth for the shape;
`docs/research/vercel-two-services.md` is the primary-source research behind it,
including the two build traps the prototype paid for.

---

# The modular rebuild

Target architecture. One module, one job, done well. Deep modules: a lot of
behaviour behind a small interface at a clean seam. Every module is also an
agent-callable tool — usable in the flow or alone.

## The greenfield rule — read before every decision

**Everything shipped so far is a learning prototype.** It proved the domain. It
does not get a vote on the rebuild.

For every piece of existing code, config, convention or dependency, ask one
question:

> On a greenfield build, knowing what we know now, would this be the **first**
> choice?

**Yes** → carry it in. **Anything else** → it is out. Rewrite it.

These are **not** valid arguments to keep something:

- it already works
- rewriting costs time
- we learned a lot building it
- the tests would have to be rewritten
- it was hard to get right

Sunk cost is not evidence. A thing that is merely _good enough_ is out; only
_first choice_ is in.

Already out by this rule: hand-rolled `tsx` test scripts (Vitest is the first
choice), the flat `src/*.ts` layout (packages with enforced entry points are),
and `/detect` + `/objects` + `/embed` as separate routes (a model catalogue is).

What survives, survives on merit and must be able to say why — a measurement, a
standard, or a property nothing else gives. Record that reason where the
decision lives, not in a chat.

## Modules

| Module     | Its one job                                                 |
| ---------- | ----------------------------------------------------------- |
| `store`    | bytes by key, public or private                             |
| `records`  | everything known about a file, in a DB                      |
| `models`   | run named models over an image, return labelled regions     |
| `identify` | say who or what a region is                                 |
| `frame`    | choose the crop window — pure maths, no pixels              |
| `redact`   | hide what must not be shown                                 |
| `compose`  | lay out a template, emit its occlusion zones                |
| `gateway`  | one endpoint: auth, quota, pricing, routing                 |
| `webui`    | gallery and what-happened view. Second-class citizen        |
| `front`    | the hop before the MCP Door: forward all, name a cold start |

`models` is a **catalogue**, not a face service. Shared models only for now;
per-consumer models are the direction, not the first step.

**One adapter per model, hand-written.** Do not generalise the middle — it
cannot be. Standardise only the edges: same input in, same output out.

- Input: the host decodes **once** and passes the decoded image to every
  adapter. Decode is paid once however many adapters run, and it dominates on a
  large photograph: `decode;dur=248.1, yunet;dur=69.4` on a 5878x7348 fixture
  against `decode;dur=23.0, yunet;dur=49.1` on the 1280x1600 crew fixture
  (364 KB), both on the models container at 1 vCPU (`docs/specs/models.md`).
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
- **Commit before every mutation.** See "Prove a test can fail" above.
- **Commit subjects are 80 characters or fewer.** The `skilly / gate`
  conventional-commits rule fails a longer one, and a PR title is often longer
  than its squash subject: set `--subject` on merge.
- **The pre-commit suite is not built for many concurrent agents.** Sixteen
  parallel vitest processes time it out. `--no-verify` after a green
  `pnpm check` is the accepted escape; say so in the PR body. CI is the gate.
- **After a force-push, trust only the CI run whose `head_sha` is the head.**
  CI skipped `synchronize` runs on one PR for about an hour, so a green tick
  beside a stale sha means nothing.
- **Merge order is the orchestrator's.** #198 renamed a method and #200 used
  the old name; both green, merged the wrong way round, and `main` failed
  typecheck until #202.

## The orchestrator

Read-only on `src/`. Never writes a module. Its job: hand out briefs, answer
questions, confirm seams, relay review verdicts, own merge order, keep the
product aligned, and verify against production between phases.

**The ticket is the channel.** A message between agents is not durable: it
reaches one context window, and it is gone when that window is. Every decision,
answer and deviation is posted on the ticket it belongs to, and a `🤖 decision`
comment on the map issue when it binds more than one module. Message an agent to
wake it; write down what you told it. An agent that has to ask twice is an agent
whose answer was never written down.
