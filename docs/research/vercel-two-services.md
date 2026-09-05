# Two containers, one Vercel project: current first-choice approach

Researched 2026-09-06 against vercel.com/docs and vercel.com/changelog (primary
sources only), then corrected the same day against live deployments where the
builder disagreed with the docs. `DEPLOY.md` is the operational source of
truth and this document does not contradict it; where a doc quotation here and
a measurement disagree, the measurement stands.

## Summary

Vercel's current first-choice mechanism for "two tightly coupled containers,
one project" is the **`services`** model in `vercel.json` (GA as of the
2026-06-30 changelog entry, superseding the older `experimentalServices` key).
Each service gets a `root`, an optional `runtime: "container"`, and an
`entrypoint` naming its Dockerfile/Containerfile path relative to that
service's `root`.

**The docs say both of DEPLOY.md's build-context gotchas are gone. They are
not.** Measured 2026-09-06 against live deployments: the `entrypoint` basename
is still validated against a fixed list, and the build context is still the
entrypoint's own directory rather than the service's `root`. Section 2 carries
the deployment ids and the verbatim errors, and the recommendation at the end
is written to what deploys, not to what is documented. Read those two before
trusting the doc quotations in between.

Public exposure is via top-level `rewrites` targeting
`{"service": "name"}`; private service-to-service calls go through
**bindings**, which inject a deployment-aware URL env var into the caller at
runtime only (not at build time, not in Routing Middleware). Region pinning
for a service is not a documented service-level field — it goes through that
service's own `functions` block, using the same `regions` mechanism as
ordinary Vercel Functions. Environment variables remain a project/environment
concept (Production/Preview/Development), not a documented per-service scope;
this is flagged as unverified below. Scale-to-zero and cold-start behavior for
container-backed services is identical to any other Vercel Function running a
container image: 5 minutes idle in production (30s in preview) before
scale-down, `SIGTERM` with a 30s grace period on shutdown.

## 1. The `services` key: schema, Dockerfile placement, directory scoping

`services` is a top-level `vercel.json` key. Each entry is a service
configuration object ([Service configuration
reference](https://vercel.com/docs/services/config-reference), last updated
2026-06-30):

| Field                                                                                   | Type                   | Notes                                                                                                                    |
| --------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `root`                                                                                  | `string`, **required** | "The path to the service root, relative to `vercel.json`."                                                               |
| `framework`                                                                             | `string`               | Framework slug, e.g. `"nextjs"`, `"fastapi"`. Auto-detected if omitted.                                                  |
| `runtime`                                                                               | `string`               | Runtime for the service; auto-detected if omitted. Set to `"container"` to force a Docker/OCI build.                     |
| `entrypoint`                                                                            | `string`               | "The framework or runtime entrypoint, such as `main:app` for a Python ASGI app or a file path for Node.js."              |
| `installCommand`, `buildCommand`, `devCommand`, `ignoreCommand`, `outputDirectory`      | `string`               | Same semantics as the top-level `vercel.json` fields, scoped to this service.                                            |
| `bindings`                                                                              | `array`                | Caller-side declarations of other services to reach privately.                                                           |
| `functions`, `headers`, `redirects`, `rewrites`, `routes`, `cleanUrls`, `trailingSlash` | —                      | Same shape as top-level `vercel.json`, but scoped to run only after a request has already been routed into this service. |

Source: [Service configuration reference](https://vercel.com/docs/services/config-reference).

Container-specific detail comes from [Container
Images](https://vercel.com/docs/functions/container-images) (last updated
2026-07-07) and the [Services](https://vercel.com/docs/services) overview
(last updated 2026-08-10):

- To build a service from a Dockerfile/Containerfile instead of framework
  auto-detection, set `"runtime": "container"` on that service:

  ```json
  {
    "services": {
      "frontend": { "runtime": "container", "root": "frontend/" },
      "backend": { "runtime": "container", "root": "backend/" }
    }
  }
  ```

  (["Using custom container images with services"](https://vercel.com/docs/services#using-custom-container-images-with-services))

- The canonical two-service container example, verbatim from [Container
  Images](https://vercel.com/docs/functions/container-images):

  ```json
  {
    "services": {
      "frontend": { "root": "frontend/", "entrypoint": "Dockerfile.vercel" },
      "backend": { "root": "backend/", "entrypoint": "Dockerfile.vercel" }
    },
    "rewrites": [
      { "source": "/api/(.*)", "destination": { "service": "backend" } },
      { "source": "/(.*)", "destination": { "service": "frontend" } }
    ]
  }
  ```

  With `frontend/Dockerfile.vercel` and `backend/Dockerfile.vercel` as
  sibling files under each service's own directory. Quoting the doc directly:
  "Set the `entrypoint` key to the path of your dockerfile, **relative to the
  service's `root`**, for each service that uses a custom container image."

- A service is **private by default**. Quoting [Services](https://vercel.com/docs/services):
  "A service is internal by default and will not be routable from the
  Internet unless you expose it. To route a service publicly, include a
  top-level rewrite rule that targets the service as `destination`." Public
  exposure is entirely a function of whether a top-level `rewrites` entry
  names that service — there is no separate "public: true/false" flag.

- Directory scoping to a service is exactly the `root` field: everything the
  service's build sees (source files, its own `package.json`/dependency
  manifest if not using a container, or its Dockerfile context if it is) is
  rooted at that path relative to `vercel.json`.

- Standalone container images (no `services` key at all) still work via
  auto-detected `Dockerfile.vercel`/`Containerfile.vercel` at the **project
  root**: "Get started by creating a `Dockerfile.vercel` (or
  `Containerfile.vercel`) file placed at the root of your project. Vercel
  automatically detects these files and adds a rewrite rule to route all
  traffic to the container image." ([Container
  Images](https://vercel.com/docs/functions/container-images)) — this is the
  single-container path meco already uses for the `meco` service today, and
  is separate from the `services` multi-container model.

## 2. Build context rules — DEPLOY.md's two gotchas, re-checked

DEPLOY.md (`/Users/tim/repo/meco/DEPLOY.md`, lines 139–166) records two
failed deployments building the `meco-faces` container under the _previous_
container/rewrite mechanism (not the `services` key — meco's `vercel.json`
predates GA `services` and instead declares an `entrypoint`-bearing block
directly plus a rewrite, matching the pre-`services` container model):

> **The `entrypoint` basename must be a Dockerfile or a Containerfile.** A
> descriptive name is refused before anything is built:
>
> ```
> Error: Container service "meco-faces" has invalid "entrypoint" "Dockerfile.faces".
> It must name a Dockerfile or Containerfile.
> ```

> **The build context is the entrypoint's own directory, and `root` is
> ignored.** Moving the file to `packages/faces/Dockerfile.vercel` gets past
> the first check and then cannot see the workspace lockfile:
>
> ```
> Error: building at STEP "COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./":
> checking on sources under "/vercel/path0/packages/faces":
> copier: stat: "/pnpm-lock.yaml": no such file or directory
> buildah build … -f /vercel/path0/packages/faces/Dockerfile.vercel /vercel/path0/packages/faces
> ```
>
> So the file has to sit at the repository root, and its basename has to be
> one of the two Vercel accepts.

### Do these gotchas still hold today?

**Yes. Both do. Measured 2026-09-06 on the meco project — see the block at the
end of this section.** What follows first is what the docs say, because the
gap between the two is the finding.

**The docs describe both differently, and more favorably.**
The current `services` model's `entrypoint` field is documented as a general
path ("The framework or runtime entrypoint, such as `main:app` for a Python
ASGI app or a file path for Node.js" — [Service configuration
reference](https://vercel.com/docs/services/config-reference)), and the
container-specific guidance is explicit that `entrypoint` may be a path
**inside the service directory**, not a bare basename that must literally
equal `Dockerfile` or `Containerfile`:

> "Set the `entrypoint` key to the path of your dockerfile, relative to the
> service's `root`, for each service that uses a custom container image."
> ([Container Images](https://vercel.com/docs/functions/container-images))

The worked example uses `entrypoint: "Dockerfile.vercel"` sitting directly
under `frontend/` and `backend/` respectively — i.e. a **custom filename**
(`Dockerfile.vercel`, not bare `Dockerfile`) resolved **relative to that
service's own root**, which is the opposite of both DEPLOY.md failures:

1. The basename-must-be-Dockerfile-or-Containerfile restriction is not present
   in the current `services`/container-images docs — the example itself uses
   `Dockerfile.vercel`, a non-canonical name, as a per-service `entrypoint`.
2. The build context is documented as the service's `root`, not "the
   entrypoint's own directory" independent of `root` — the whole point of the
   worked example is that `frontend/Dockerfile.vercel` builds with
   `frontend/` as context and `backend/Dockerfile.vercel` builds with
   `backend/` as context, each seeing only its own service directory. There
   is no reproduction of meco's "workspace lockfile at the repo root is
   invisible to a nested Dockerfile" failure in current docs — because in the
   current model, the whole point is that the service's `root` **is** the
   build context, and a workspace-wide file such as `pnpm-lock.yaml` would
   need to be copied in from within that context, e.g. via a multi-stage
   build issuing `COPY ../../pnpm-lock.yaml` semantics are not supported by
   Docker's context isolation — so a container service that needs
   workspace-root files still needs `root` set to the workspace root with a
   nested `entrypoint` path, or the lockfile copied/vendored into the service
   directory before build. Current docs do not show a "root at monorepo root,
   entrypoint nested two directories down" example, so meco's exact failure
   mode 2 (needing the _repo_ root as context while the Dockerfile lives
   nested) is not directly contradicted or confirmed for that specific
   combination — flagged as unverified below.

I could not find a changelog entry that names these two specific bugs
("entrypoint basename validation", "root ignored for container build
context") as historical defects that were fixed — the current docs simply
describe a different, non-basename-restricted, `root`-scoped model. It is
plausible DEPLOY.md's failures were against the **pre-`services`**,
single-container `Dockerfile.vercel`-at-project-root mechanism (which meco
still uses for its main `meco` service), which never supported a `root`
config for containers at all — under that mechanism "root": "." for a
container was always a no-op because there was no per-container root concept,
only a single project-root auto-detected file. That reading is consistent
with DEPLOY.md's own text ("A root-level `Containerfile` is what is left") —
meco's `meco-faces` service was very likely declared through the _legacy_
container-service mechanism, not through GA `services`, since meco's
`vercel.json` predates the `services` GA changelog date. **This is my
interpretation connecting DEPLOY.md's account to the versioned docs, not a
literal Vercel statement that "this bug used to exist and was fixed" — flagged
as inference, not a sourced claim.**

### Measured 2026-09-06 — both gotchas still hold

Everything above this heading is what the documentation says. The builder does
something else. Two preview deployments on Vercel project
`timschochs-projects/meco`, GA `services` with `runtime: "container"`, settle
it. **Where this section and the reading of the docs above disagree, this
section wins**, and `DEPLOY.md` is written to it.

**Gotcha 1 holds: the `entrypoint` basename comes from a fixed list.** It is
validated before anything is built. Deployment
`dpl_2r67PFbajSyQAeqw9LKbu2eM26mK`, with
`"entrypoint": "Containerfile.gateway"`:

```
Error: Container service "gateway" has invalid "entrypoint" "Containerfile.gateway".
It must name a Dockerfile or Containerfile.
```

So the "custom filename" reading of the `Dockerfile.vercel` worked example is
wrong: `Dockerfile.vercel` is itself on the accepted list, not an example of
arbitrary naming.

**Gotcha 2 holds: the build context is the entrypoint's own directory, not the
service's `root`.** Deployment `dpl_7q2U1yZ228j4crCeoB6UyvdUcSjL`, with
`"root": "."` and `"entrypoint": "packages/gateway/Containerfile"`:

```
Error: building at STEP "COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./":
checking on sources under "/vercel/path0/packages/gateway":
copier: stat: "/pnpm-lock.yaml": no such file or directory
```

The buildah invocation, from the same log, shows the context argument
explicitly — it is the entrypoint's directory, and `root` did not set it:

```
buildah build --platform linux/amd64 --layers --network host \
  -t vcr.vercel.com/timschochs-projects/meco/gateway:4e9e063177af \
  -f /vercel/path0/packages/gateway/Containerfile /vercel/path0/packages/gateway
```

This is the combination the original research flagged as unverified and worth
testing against a live deployment. It is now tested, and it fails.

`root` is not a no-op: it is what `entrypoint` resolves against. It just does
not reach the build context.

## 3. Bindings, env scoping, regions, warmth/scale-to-zero

### Service-to-service calls (bindings)

Declared on the **caller**, per [Service bindings](https://vercel.com/docs/services/bindings):

```json
{
  "services": {
    "orders": {
      "root": "services/orders/",
      "bindings": [
        {
          "type": "service",
          "service": "inventory",
          "format": "url",
          "env": "INVENTORY_URL"
        }
      ]
    },
    "inventory": { "root": "services/inventory/", "entrypoint": "main:app" }
  },
  "rewrites": [
    { "source": "/api/(.*)", "destination": { "service": "orders" } }
  ]
}
```

Binding fields — `type` (must be `"service"`), `service` (target name),
`format` (must be `"url"`), `env` (env var name receiving the generated URL) —
all required. Key properties, quoted:

- "The binding grants that access and injects the target URL as
  `INVENTORY_URL`, which server-side code in `orders` reads to build request
  URLs."
- "The target stays unreachable from the internet unless a separate top-level
  rewrite exposes it, so a binding grants internal access without creating a
  public route."
- "Vercel injects the binding as a URL base, and the value is
  deployment-aware." — a preview deployment's caller reaches that same
  preview's callee, never a fixed hostname.
- "Internal calls also skip the public request pipeline. Firewall, Deployment
  Protection, the project's top-level middleware, and CDN request accounting
  do not apply to a service-to-service call."
- "A binding grants internal access only. It does not authenticate or
  authorize the call. If you need application-level authorization between
  services, handle it in your service code."
- Availability: "Bindings are available to a service's functions at runtime
  only. They do not resolve during builds, and code running in middleware
  cannot call another service over a binding."
- "Service bindings aren't available yet for services that use the Go or
  Rust runtime. … A container image service can use bindings." Node.js and
  Python are unaffected.

(All quotes: [Service bindings](https://vercel.com/docs/services/bindings).)

### Env var scoping per service

**No documented per-service env-var scope was found.** Vercel's environment
variable model, per [Managing environment
variables](https://vercel.com/docs/environment-variables/managing-environment-variables),
scopes a variable to a **deployment Environment** (Production / Preview /
Development / a custom environment) at the **project** level — there is no
mention of scoping a variable to one `services` entry. The `services`
config-reference page lists no `env` field on the service object (only
`bindings`, which are a distinct mechanism — an _injected_, generated URL, not
a user-set variable). **This is a gap, not a confirmed absence**: I found no
page stating "env vars cannot be scoped per service," only that no documented
mechanism sets one. Every service in a project draws from the same
project-level env var set for a given Environment; the only per-service
variance mechanism found in the docs is a binding's generated URL. Flagged as
unverified/absent-by-omission rather than a sourced negative claim.

### Region pinning for containers

Not a `services`-specific field. Region pinning is the general Vercel
Functions mechanism, applied inside a service's own scoped `functions` block
(per [Service configuration reference](https://vercel.com/docs/services/config-reference),
`functions` is a valid per-service key mapped to ["Function
configuration"](https://vercel.com/docs/project-configuration/vercel-json#functions)).
The underlying mechanism, per [Configuring regions for Vercel
Functions](https://vercel.com/docs/functions/configuring-functions/region):

- Project-wide default: `{"regions": ["sfo1"]}` at the top level (or, inside a
  service object, presumably scoped there — not explicitly demonstrated for
  `services` in the fetched docs).
- Per-function override via the `functions` map:
  ```json
  { "functions": { "api/eu-data.js": { "regions": ["cdg1"] } } }
  ```
- Plan limits: Hobby = 1 region, Pro = 5, Enterprise = all.
- Default region for new projects is `iad1` (Washington, D.C.).

No fetched page states container-image services have a different region
model than ordinary Functions; [Container
Images](https://vercel.com/docs/functions/container-images) says only that
"[Secure Compute](/docs/networking/secure-compute) and [Static
IPs](/docs/networking/static-ips) are not yet supported with custom container
images" — no region-specific carve-out. Region pinning for a container
service is therefore inferred to work exactly like any Vercel Function's
`regions`/`functions` config, applied at the service level; I did not find a
worked example combining `services` + `runtime: "container"` + `regions` in
one snippet, so the exact placement (top-level `regions` vs. per-service
`functions.<path>.regions`) is not directly demonstrated for the container
case — flagged as unverified.

### Instance warmth / scale-to-zero

From [Container Images](https://vercel.com/docs/functions/container-images)
("Scale in behavior"):

> "Functions not receiving any traffic for 5 minutes in production
> environments, and 30 seconds in preview environments, will automatically
> scale down."
>
> "When a function instance is scaled down, the container receives a
> `SIGTERM` signal with a 30 seconds grace period to clean up before being
> forcefully terminated."

From [Functions API Reference](https://vercel.com/docs/functions/functions-api-reference#sigterm-signal):

> "A `SIGTERM` signal is sent to a function when it is about to be
> terminated, such as during scale-down events. … Your code can run for up to
> 500 milliseconds (**30 seconds for container images**) after receiving a
> `SIGTERM` signal."

Port/listen contract: "The default port is `80`, and it can be overridden by
setting the `PORT` environment variable in the project settings." Billing is
Active CPU pricing — "You are only billed for CPU when your code is actively
running, not while waiting for I/O or sleeping" — meaning a warm-but-idle
container instance costs nothing extra beyond keeping the instance alive
until the 5-minute (prod) / 30-second (preview) idle scale-down.

No separate "warmth" API or knob is documented for containers beyond this
idle-timeout/SIGTERM contract — matching what DEPLOY.md's own measurements
independently observed (`/health` reporting `"warm": false` per-instance,
cold starts costing ~200–2500ms depending on which model session an instance
has not yet created).

## Recommendation for meco — what shipped

This section was rewritten on 2026-09-06 to match what deploys. The original
recommendation was a per-package `Dockerfile.vercel` with `root` set to that
package, read off the container-images doc's canonical example. It does not
build: section 2's measurement shows the context follows the entrypoint, not
`root`, and a pnpm workspace cannot install from one package directory.

`gateway` and `models` are two `services` entries, each `runtime: "container"`,
each with a Containerfile **at the repository root**, named from Vercel's
accepted list.

### Directory layout

```
meco/
├── vercel.json
├── Containerfile           # builds gateway
├── Dockerfile.vercel       # builds models
├── package.json            # workspace root
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── packages/
    ├── gateway/
    └── models/
```

The two names carry no meaning and cannot be made to — the basename is
validated against a fixed list, so a descriptive name is refused. Each file's
first line names the service it builds, and `vercel.json` is the map.

### `vercel.json`

```json
{
  "services": {
    "gateway": {
      "root": ".",
      "runtime": "container",
      "entrypoint": "Containerfile",
      "bindings": [
        {
          "type": "service",
          "service": "models",
          "format": "url",
          "env": "MODELS_URL"
        }
      ]
    },
    "models": {
      "root": ".",
      "runtime": "container",
      "entrypoint": "Dockerfile.vercel"
    }
  },
  "rewrites": [{ "source": "/(.*)", "destination": { "service": "gateway" } }]
}
```

Notes on this shape:

- **Two services sharing `root: "."` is accepted.** Verified on deployment
  `BDmBEqXDeytYSkE6ucXwxXwKBWjW`, 2026-09-06: both images built and both
  services ran. Distinct roots are not required.
- `models` gets **no top-level rewrite**, so it is private per section 1 —
  only reachable from `gateway` over the `MODELS_URL` binding, which matches
  the module table's intent ("`gateway` — one endpoint: auth, quota, pricing,
  routing"). Confirmed by request: on the same deployment, `/health` answers
  from `gateway` and every other path, `/models/health` included, gets
  `gateway`'s 404.
- Each Containerfile `COPY`s from the repository root, which is its context:
  `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `packages/`. No
  vendoring, no symlinks, no build arg — the workspace files are simply in the
  context. `.dockerignore` at the root keeps `node_modules`, `dist`,
  `fixtures` and `docs` out of it.
- The runtime stage copies a bundled entry point and nothing else. pnpm's
  workspace symlinks do not survive a `COPY`, so the image carries no
  `node_modules`.
- The end-to-end proof, deployment `BDmBEqXDeytYSkE6ucXwxXwKBWjW`:

  ```
  $ curl -s https://meco-d3ee5vv0c-timschochs-projects.vercel.app/health
  {"ok":true,"service":"gateway","version":"5ea23b38b1c0937198dd7f646cf917a62a6f1a01","models":{"bound":true,"reachable":true,"status":200}}
  ```

  Both containers built, `gateway` is publicly routed, the binding injected
  `MODELS_URL`, and `models` answered its own `/health` with a 200 over it.

- Env vars (`MECO_TOKEN`, the Blob tokens) still go through project-level
  Environment scoping (Production/Preview/Development) — no per-service env
  scoping is documented, so both services see the same superset of project env
  vars for a given Environment; use distinct variable names per service where
  they would otherwise collide.
- Call `models` from `gateway` with
  `fetch(new URL(path, process.env.MODELS_URL))`, from a route handler or
  function only — never from Routing Middleware, and never expect the binding
  to resolve during the build step.

## Settled by measurement, not by a source

1. **DEPLOY.md's two failures are not historical.** Both reproduce on GA
   `services` with `runtime: "container"` — see "Measured 2026-09-06" in
   section 2 for the deployment ids and the verbatim errors. No changelog
   entry names either as a fixed defect because neither was fixed. The
   earlier reading of this document — that meco had merely been on a
   superseded legacy mechanism — was wrong.
2. **A container service cannot set `root` to the monorepo root and point
   `entrypoint` at a nested Dockerfile to get repo-root build context.** It is
   accepted and then builds with the nested directory as context. Same
   measurement.

## What could not be verified against a primary source

1. Whether env vars can be scoped per-service at all (as opposed to only per
   project-Environment). No field for this exists in the service
   configuration reference, but no page states it is impossible either.
2. Whether `regions`/`functions.<path>.regions` is confirmed to work when
   combined with `runtime: "container"` inside a `services` entry — inferred
   from the general Functions region mechanism, not shown in a container +
   services worked example.
