# Packages

One package per module. Every package is a **deep module**: a lot of behaviour
behind a small interface.

```
packages/<name>/
  index.ts      entry point — public. Import this from outside.
  server.ts     another entry point. A package may expose SEVERAL.
  lib/          implementation — private. These files import each other freely.
  tests/        tests and fixtures — private.
  package.json  "exports" lists the entry points
  tsconfig.json extends ../../tsconfig.base.json, references its dependencies
```

The public surface is the package's **root files**, not one designated
`index.ts`. Anything in a subfolder is private, so a new folder never needs a
config change.

**No barrel files.** Expose several small entry points (`app.ts`, `server.ts`)
rather than re-exporting a whole subtree through one index.

## The rules

`.dependency-cruiser.cjs` enforces ten, all `error`:

- **entrypoint-boundary-from-app** — code outside every package imports a
  package's entry points, never anything in its subfolders.
- **entrypoint-boundary-across-packages** — a package's own files import each
  other freely, but reach another package only through its entry points.
- **tests-through-entrypoints** — a package's tests exercise it the way
  everyone else does: through the entry points, never through internals, not
  even their own.
- **tests-folder-is-private** — nothing outside `tests/` imports a fixture.
- **no-circular** — no dependency cycles.
- **no-unresolvable** — an import that resolves to nothing matches no package
  path, so it would slip past every rule above it.
- **contracts-depends-on-nothing** — `contracts` is what the other modules
  agree on, so it depends on none of them.
- **services-do-not-import-each-other** — `gateway`, `models` and `front`
  deploy as separate services. `gateway` reaches `models` over the Vercel
  service binding at runtime, and imports exactly one file to do it:
  `packages/models/index.ts`, the client that holds the wire; `front` reaches
  `gateway` over a binding and imports nothing. Nothing else crosses, in any
  direction.
- **front-knows-no-tool** — `front` forwards every MCP message to the gateway
  verbatim and stays in sync with its tools by construction. An import of any
  meco package would be the first piece of tool knowledge, and the first thing
  to drift.
- **models-client-stays-thin** — a root file of `models` other than `app.ts`,
  `catalogue.ts` and `server.ts` is a client another package imports, so it may
  reach neither the ONNX Runtime, sharp, Hono nor those three host entry
  points. Read over the whole graph, not one edge.

Run them: `pnpm lint:boundaries`. `tests/boundaries.test.ts` runs the same
check and additionally asserts it goes red on a planted violation.

Third-party packages stay in the graph (`doNotFollow`, not `exclude`): a rule
about what a file reaches has to see what it reaches. Only a package's own
`packages/<name>/dist/` is excluded.

## Adding a package

Copy `packages/frame` (the smallest one), rename it, add it to the root
`tsconfig.json` `references`, and add `MODULE_NAMES` in `@meco/contracts`.
