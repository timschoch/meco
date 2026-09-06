// @ts-check
// Deep-module enforcement for dependency-cruiser.
//
// Each package under the packages root is a DEEP MODULE: a lot of behaviour
// behind a small interface. A package's PUBLIC SURFACE is its ENTRY POINTS:
// the files at the package root. Implementation lives in SUBFOLDERS and is
// private (by convention `lib/` for implementation and `tests/` for tests,
// though any subfolder is private). A package may expose several small entry
// points (index.ts, client.ts, server.ts, …); prefer that over one giant
// barrel index.
//
// The only thing you should ever need to edit here is PACKAGES_ROOT.

/** Where packages live. One immediate child dir per package (flat, no nesting). */
const PACKAGES_ROOT = "packages";

// --- derived patterns (no need to edit) -------------------------------------
const R = PACKAGES_ROOT;
/**
 * A package's private internals: anything nested inside a package subfolder.
 * The package's root files are its entry points and are NOT matched here:
 * they stay importable from outside.
 */
const PACKAGE_INTERNALS = `^${R}/[^/]+/[^/]+/`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "entrypoint-boundary-from-app",
      comment:
        "App/root code may import a package's entry points (its root files), but nothing inside its subfolders.",
      severity: "error",
      from: { pathNot: `^${R}/` }, // importer is NOT inside any package
      to: { path: PACKAGE_INTERNALS },
    },
    {
      name: "entrypoint-boundary-across-packages",
      comment:
        "A package's own files import each other freely, but may reach OTHER packages only through their entry points, never their internals.",
      severity: "error",
      // importer is inside a package ($1), but is not a test file
      from: { path: `^${R}/([^/]+)/`, pathNot: `^${R}/[^/]+/tests/` },
      to: {
        path: PACKAGE_INTERNALS,
        pathNot: `^${R}/$1/`, // same package → intra-package freedom
      },
    },
    {
      name: "tests-through-entrypoints",
      comment:
        "A package's tests exercise it through its entry points like everyone else: they may import any package's entry points and their own tests/ fixtures, but never any package's internals, not even their own.",
      severity: "error",
      from: { path: `^${R}/([^/]+)/tests/` }, // a test file, in package $1
      to: {
        path: PACKAGE_INTERNALS,
        pathNot: `^${R}/$1/tests/`, // own tests/ fixtures → allowed
      },
    },
    {
      name: "tests-folder-is-private",
      comment:
        "A package's tests/ folder is reachable only from tests: nothing else may import fixtures.",
      severity: "error",
      from: { pathNot: `^${R}/[^/]+/tests/` }, // importer is not itself a test
      to: { path: `^${R}/[^/]+/tests/` },
    },
    {
      name: "no-circular",
      comment:
        "No dependency cycles. Scope to `^${R}/` if you want to allow cycles outside packages.",
      severity: "error",
      from: {},
      to: { circular: true },
    },

    {
      name: "no-unresolvable",
      comment:
        "An import that cannot be resolved is a boundary the path rules never see: it matches no package path, so every layering rule below it silently passes.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },

    // --- Layering: which packages may depend on which -----------------------
    // Interface hiding controls HOW you import (through the entry points).
    // Layering controls WHICH packages may depend on which.
    {
      name: "contracts-depends-on-nothing",
      comment:
        "`contracts` is what the other modules agree on. It may not depend on any of them, or the agreement moves with whatever it imports.",
      severity: "error",
      from: { path: `^${R}/contracts/` },
      to: { path: `^${R}/(?!contracts/)` },
    },
    {
      name: "services-do-not-import-each-other",
      comment:
        "`gateway` and `models` deploy as separate containers. gateway reaches models over the Vercel service binding at runtime, and imports exactly one file to do it: `models/index.ts`, the client that holds the wire. Nothing else crosses, in either direction.",
      severity: "error",
      from: { path: `^${R}/(gateway|models)/` },
      to: {
        path: `^${R}/(gateway|models)/`,
        pathNot: [`^${R}/$1/`, `^${R}/models/index\\.ts$`],
      },
    },
    {
      name: "models-client-stays-thin",
      comment:
        "A root file of `models` that is not the host's own entry point is a client: another package imports it, so it must carry the wire and no server. It may reach neither the ONNX Runtime, sharp, Hono nor `app`/`catalogue`/`server` — not directly, and not through anything it imports, which is why this rule is `reachable`. Without it the gateway image would gain the runtime and the weights from one import.",
      severity: "error",
      from: {
        path: `^${R}/models/[^/]+[.]ts$`,
        pathNot: `^${R}/models/(app|catalogue|server)[.]ts$`,
      },
      to: {
        path: [
          `^${R}/models/(app|catalogue|server)[.]ts$`,
          // Anywhere in the path, not anchored: pnpm files a package under
          // `node_modules/.pnpm/<name>@<version>/node_modules/<name>/`.
          "(^|/)node_modules/(onnxruntime-node|sharp|hono|@hono/[^/]+)/",
        ],
        reachable: true,
      },
    },
  ],
  options: {
    // A dependency on a package is followed no further than the package: its
    // own internals are not our boundaries. It stays IN the graph, though —
    // excluding it would hide the one thing `models-client-stays-thin` is
    // about, which is whether the client reaches sharp or the ONNX Runtime.
    doNotFollow: { path: "node_modules" },
    // A package's own `dist/` is build output: emitted declarations would
    // otherwise be cruised as if they were source, and their unresolvable
    // relative imports would drown out every real violation. Anchored to a
    // package, because most published packages ship from `dist/` too and an
    // unanchored pattern quietly drops sharp and Hono from the graph — which
    // is the graph `models-client-stays-thin` reads.
    exclude: {
      path: `(^${R}/[^/]+/dist/|(^|/)[.](temp|agents|claude)/)`,
    },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
      exportsFields: ["exports"],
      conditionNames: ["types", "import", "require", "node", "default"],
      mainFields: ["module", "main", "types"],
    },
  },
};
