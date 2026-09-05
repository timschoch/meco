// The live check every ticket runs: post a fixture to a deployed models
// container and print what came back. Node 24 runs it as is, no build step.
//
//   pnpm --filter @meco/models probe <baseUrl> [fixture] [models]
//
//   baseUrl  where models answers, e.g. http://127.0.0.1:8791
//   fixture  a path, default fixtures/faces/artemis-2-crew.jpg
//   models   the `?models=` value, default every Catalogue entry
//
// Prints `GET /health` before and after, then the `/annotate` status, its
// `Server-Timing`, the wall time, and the Annotation. Exit code 1 when the
// answer is not a 200. Nothing here parses with contracts: the probe shows
// what the wire carried, and the tests are where the shape is asserted.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [baseUrl, fixtureArg, models] = process.argv.slice(2);
if (!baseUrl) {
  console.error("usage: probe <baseUrl> [fixture] [models]");
  process.exit(2);
}
const base = baseUrl.replace(/\/$/, "");
// pnpm runs the script in the package directory and leaves the caller's
// directory in INIT_CWD, so a relative fixture path means what the caller meant.
const fixture = fixtureArg
  ? resolve(process.env["INIT_CWD"] ?? process.cwd(), fixtureArg)
  : fileURLToPath(
      new URL("../../../fixtures/faces/artemis-2-crew.jpg", import.meta.url)
    );

async function health(label: string): Promise<void> {
  const res = await fetch(`${base}/health`);
  console.log(`health ${label}: ${res.status} ${await res.text()}`);
}

await health("before");

const bytes = await readFile(fixture);
const url = `${base}/annotate${models ? `?models=${models}` : ""}`;
console.log(`POST ${url} (${bytes.byteLength} bytes from ${fixture})`);

const started = performance.now();
const res = await fetch(url, { method: "POST", body: new Uint8Array(bytes) });
const wall = performance.now() - started;
const body = await res.text();

console.log(`status ${res.status} in ${wall.toFixed(0)}ms`);
console.log(`Server-Timing: ${res.headers.get("server-timing") ?? "(none)"}`);
console.log(body);

await health("after");

process.exitCode = res.ok ? 0 : 1;
