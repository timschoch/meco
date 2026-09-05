# meco

Ten packages under `packages/`, one per module. Each is a deep module whose
only public surface is its root files; `.dependency-cruiser.cjs` enforces that.
See [packages/README.md](./packages/README.md).

`gateway` and `models` also deploy as containers — two Vercel services in one
project. See [DEPLOY.md](./DEPLOY.md).

```
pnpm install
pnpm check     # typecheck, boundaries, tests
pnpm build     # bundles the two container entry points
```
