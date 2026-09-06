// The live check every ticket runs: post a fixture to a deployed models
// container and print what came back. Node 24 runs it as is, no build step.
//
//   pnpm --filter @meco/models probe <baseUrl> [fixture] [models]
//
//   baseUrl  where models answers, e.g. http://127.0.0.1:8791
//   fixture  a path, default fixtures/faces/artemis-2-crew.jpg
//   models   the `?models=` value, default every Catalogue entry
//
// Prints `GET /health` before and after, then the wall time and the
// Annotation. It calls through the client the gateway uses, hash check on, so
// the live run exercises the same code path production does; a `ModelsError`
// says which side refused and exits 1.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createModelsClient, ModelsError } from "../index";

const [baseUrl, fixtureArg, models] = process.argv.slice(2);
if (!baseUrl) {
  console.error("usage: probe <baseUrl> [fixture] [models]");
  process.exit(2);
}
// pnpm runs the script in the package directory and leaves the caller's
// directory in INIT_CWD, so a relative fixture path means what the caller meant.
const fixture = fixtureArg
  ? resolve(process.env["INIT_CWD"] ?? process.cwd(), fixtureArg)
  : fileURLToPath(
      new URL("../../../fixtures/faces/artemis-2-crew.jpg", import.meta.url)
    );

// The client answers with the Annotation, not the response, so the probe wraps
// the fetch it hands in to keep the header the host times each stage in.
let timing: string | null = null;
const client = createModelsClient({
  baseUrl,
  fetch: async (request) => {
    const response = await fetch(request);
    timing = response.headers.get("server-timing");
    return response;
  },
});

async function health(label: string): Promise<void> {
  console.log(`health ${label}: ${JSON.stringify(await client.health())}`);
}

await health("before");
console.log(`catalogue: ${JSON.stringify(await client.catalogue())}`);

const bytes = new Uint8Array(await readFile(fixture));
// The gateway's own check: the hash it filed the bytes under must be the hash
// the Annotation names, or the wire did not carry the bytes it was given.
const hash = createHash("sha256").update(bytes).digest("hex");
console.log(
  `POST ${baseUrl}/annotate (${bytes.byteLength} bytes from ${fixture}, sha256 ${hash})`
);

const started = performance.now();
try {
  const annotation = await client.annotate(bytes, {
    hash,
    ...(models ? { models: models.split(",") } : {}),
  });
  console.log(`ok in ${(performance.now() - started).toFixed(0)}ms`);
  console.log(`Server-Timing: ${timing ?? "(none)"}`);
  console.log(JSON.stringify(annotation));
} catch (error) {
  if (!(error instanceof ModelsError)) throw error;
  console.error(
    `${error.code}${error.status ? ` (${error.status})` : ""}: ${error.message}`
  );
  console.error(`Server-Timing: ${timing ?? "(none)"}`);
  process.exitCode = 1;
}

await health("after");
