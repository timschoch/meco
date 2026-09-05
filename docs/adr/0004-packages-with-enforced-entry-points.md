# ADR-0004 — packages with enforced entry points

Status: **accepted, 6 Sep 2026**. Ticket: [#71](https://github.com/timschoch/meco/issues/71), under the modular rebuild map [#60](https://github.com/timschoch/meco/issues/60). Deploy shape from [`../research/vercel-two-services.md`](../research/vercel-two-services.md).

## Context

The prototype put every module in one flat `src/*.ts`. Nothing stopped one file
from importing another, so nothing recorded where a seam was. `crop-solver.ts`
and `brands.ts` were separate ideas held apart by discipline alone, and
discipline is not a boundary — it is a thing an agent has to be told about
every time.

The rebuild hands one module to one agent. That only works if an agent can
answer "what may I import from this module?" by reading the filesystem instead
of by reading the module. A boundary that lives in a document is a boundary the
next agent breaks.

`gateway` and `models` additionally deploy as two containers, so at least one
seam has to survive being a network hop.

## Decision

**One package per module under `packages/<name>/`, and a package's public
surface is its root files.** Anything in a subfolder is private. Convention is
`lib/` for implementation and `tests/` for tests, but the rule is depth, not
folder names, so a new folder never needs a config change.

- **`.dependency-cruiser.cjs` is the enforcement**, wired into `pnpm check` and
  CI. Eight rules, all `error`: the four interface-hiding rules from the
  `setup-ts-deep-modules` skill, `no-unresolvable`, and three layering rules
  this repo adds — `contracts` depends on nothing, `gateway` and `models` never
  import each other, and no cycles.
- **`no-unresolvable` is not hygiene, it is what makes the layering rules
  work.** An import that resolves to nothing has no package path, so it matches
  no `from`/`to` pattern and every rule below it passes. Measured: with the
  rule absent, `contracts` importing `@meco/frame` was reported clean, because
  pnpm's strict linking left the specifier unresolved rather than pointing it
  at `packages/frame/`.
- **`exports` names the entry points, and points at TypeScript source.** No
  dual `dist` publish: one truth for `tsc`, Vitest and dependency-cruiser
  alike. A package may expose several small entry points — `gateway` has
  `app.ts` and `server.ts` — rather than funnel everything through one barrel.
- **Source `exports` means the containers bundle.** Node cannot load a `.ts`
  file out of `node_modules`, and pnpm's workspace symlinks do not survive a
  `COPY` into a runtime image. `esbuild` bundles each service's `server.ts` to
  one file; the runtime stage copies that file and nothing else.
- **TypeScript project references, one project per package**, referenced from
  the root `tsconfig.json`. A package can only see what its `references` list
  names, which is the same boundary again, checked by a second tool.
- **`contracts` is a package like the others**, and the only one no rule lets
  depend on anything. It is what the modules agree on; if it could import a
  module, the agreement would move with whatever it imported.

## What was rejected

- **The flat `src/*.ts` layout.** It is what the prototype had, and the
  greenfield rule gives it no vote. It records no seam.
- **One repository per module.** It enforces the boundary hardest and costs the
  most: ten lockfiles, ten CI pipelines, and a cross-module change becoming ten
  pull requests. The modules are seams, not deployables — `CLAUDE.md` already
  says to deploy as few services as the work needs.
- **`src/index.ts` as the entry point**, which the ticket asked for. The
  dependency-cruiser rules decide public and private by path depth: with
  `src/index.ts` the entry point is itself inside a subfolder, so it is private
  and every rule inverts. Root-level entry points is what the skill prescribes
  and what the rules can express.
- **`noEmit` on the referenced projects.** TypeScript refuses it outright —
  `TS6310: Referenced project ... may not disable emit`. Each package emits
  declarations only, into its gitignored `dist/types`.
- **The `esbuild` CLI.** pnpm writes its bin shim before esbuild's postinstall
  swaps that path for a native binary, so the shim runs a Mach-O file through
  `node` and dies on `SyntaxError: Invalid or unexpected token`. The JS API in
  a four-line `build.mjs` has no shim to get wrong.

## Consequences

A module agent reads `packages/<name>/*.ts` — the root files — and knows the
whole public surface of a module it does not own. Reaching past it fails
`pnpm check` locally, in the pre-commit hook, and in CI, before review.

Adding a package means a directory, an entry in the root `tsconfig.json`
`references`, and a name in `MODULE_NAMES`. Nothing in
`.dependency-cruiser.cjs` changes: its rules name `contracts`, `gateway` and
`models` and are otherwise generic over the layout.

The two layering rules that name services are the shape this ADR is least sure
of. They encode today's deploy topology, not a property of the domain. When a
third container appears, the rule is rewritten, not extended by hand per pair.
