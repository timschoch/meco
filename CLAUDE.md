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
  && pnpm test:detect && pnpm test:embed && pnpm test:match
```

`pnpm test:storage` runs against the live Blob store: it needs `.env.local`
and takes ~10 minutes. It is not part of the gate.

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
