// Re-records every fixture Annotation under `tests/fixtures/` by POSTing the
// source photograph to a running `models` container, and re-measures the kart
// rung's overlap constant on what came back.
//
//   pnpm --filter @meco/frame record <baseUrl>
//
//   baseUrl  where models answers, e.g. http://127.0.0.1:8791
//
// Run it whenever an adapter version changes: a fixture is a recording, and a
// recording nobody can reproduce is the inherited data this script exists to
// replace (#109).
//
// It refuses to write anything unless every Annotation names exactly the
// Catalogue that `GET /models` lists, version and all. A fixture recorded from
// half a deploy would otherwise be indistinguishable from one recorded whole.
//
// No import of `@meco/models`: frame depends on `@meco/contracts` and nothing
// else, and the wire it needs here is two GETs and a POST.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Annotation,
  type Box,
  type ModelId,
  type Region,
} from "@meco/contracts";
import { KART_FIXTURES } from "./samples";

/** The repository's `fixtures/` folder, resolved by the build. */
declare const __SOURCES__: string;
/** This folder's `fixtures/`, where the recordings are written. */
declare const __RECORDINGS__: string;

/**
 * Every recording, and the photograph it is a recording of. The name is the
 * fixture's, without its extension: `<name>.json` is written and `<name>.jpg`
 * is what `samples.ts` calls it.
 */
const SOURCES: Record<string, string> = {
  "astronaut-portrait": "faces/astronaut-portrait.jpg",
  "artemis-2-crew": "faces/artemis-2-crew.jpg",
  "soyuz-crew": "faces/soyuz-crew.jpg",
  "on-track-dark-visor": "karts/on-track-dark-visor.jpg",
  "on-track-rear-helmet": "karts/on-track-rear-helmet.jpg",
  "on-track-visor-open": "karts/on-track-visor-open.jpg",
  "paddock-mixed": "karts/paddock-mixed.jpg",
  "podium-trophy": "karts/podium-trophy.jpg",
  "podium-trophy-2": "karts/podium-trophy-2.jpg",
};

const baseUrl = process.argv[2];
if (baseUrl === undefined) {
  console.error("usage: record <baseUrl>");
  process.exit(2);
}

const modelKey = (model: ModelId) => `${model.name}@${model.version}`;

/** What `GET /models` lists, as the keys a recording has to name back. */
async function catalogueKeys(): Promise<string[]> {
  const response = await fetch(`${baseUrl}/models`);
  if (!response.ok) {
    throw new Error(`GET ${baseUrl}/models answered ${response.status}`);
  }
  const entries = (await response.json()) as ModelId[];
  return entries.map(modelKey);
}

/**
 * One recording. Parsed by the contracts schema here as well as in the tests,
 * so a host that answers something else is caught before it reaches a file.
 */
async function annotate(source: string): Promise<Annotation> {
  const response = await fetch(`${baseUrl}/annotate`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: await readFile(source),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `POST /annotate answered ${response.status}: ${JSON.stringify(body)}`
    );
  }
  return Annotation.parse(body);
}

// ---------------------------------------------------------------------------
// The overlap constant, re-measured on what was just recorded.
//
// `lib/kart.ts` is private to the package and this arithmetic is deliberately a
// second copy of it: a sweep that called the rule would only ever agree with
// the rule. The one thing that has to track `lib/kart.ts` by hand is the Kind
// gate below — if `JOINABLE` there ever changes, this measures a rule nothing
// ships. That is a stale sweep, not a wrong shipped rule: `kart.test.ts` holds
// the shipped rung against these same recorded Subjects.
//
// What it scores against is `KART_FIXTURES[].subject`, the Subject somebody
// rendered over the photograph and accepted. **It ranks bands, not points.**
// That Subject is itself a 0.25 union, so every threshold composing the same
// union scores identically and no measurement here can prefer 0.25 to 0.20.
// What it can say — and what it is for — is where the union stops being the
// accepted one on either side, which is the interval printed at the end.
// ---------------------------------------------------------------------------

const area = (b: Box) => b.width * b.height;

const overlapOfSmaller = (a: Box, b: Box): number => {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  return (width * height) / Math.min(area(a), area(b));
};

const union = (boxes: Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
};

const iou = (a: Box, b: Box): number => {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const overlap = width <= 0 || height <= 0 ? 0 : width * height;
  return overlap / (area(a) + area(b) - overlap);
};

/** The union the kart rung would compose at this threshold, and what joined. */
function kartUnion(
  annotation: Annotation,
  threshold: number
): { subject: Box; kept: string[] } | undefined {
  const vehicles = annotation.regions.filter((r) => r.kind === "vehicle");
  const pool =
    vehicles.length > 0
      ? vehicles
      : annotation.regions.filter((r) => r.kind === "person");
  const seed = pool.reduce<Region | undefined>(
    (best, r) =>
      best === undefined || area(r.box) > area(best.box) ? r : best,
    undefined
  );
  if (seed === undefined) return undefined;

  const joined = annotation.regions.filter(
    (r) =>
      r.id === seed.id ||
      ((r.kind === "person" || r.kind === "vehicle") &&
        overlapOfSmaller(r.box, seed.box) > threshold)
  );
  return {
    subject: union(joined.map((r) => r.box)),
    kept: joined.map((r) => r.id),
  };
}

/**
 * How close to the verified Subject a union has to land to count as
 * reproducing it. Four decimals is what the recordings carry, so anything
 * above this is the same rectangle and anything below is a different framing.
 */
const REPRODUCES = 0.999;

/** How many of the six a threshold reproduces, and where it does worst. */
function score(
  recorded: Map<string, Annotation>,
  threshold: number
): { reproduced: number; worst: { iou: number; name: string } } {
  let reproduced = 0;
  let worst = { iou: 1, name: "" };
  for (const { name, subject } of KART_FIXTURES) {
    const annotation = recorded.get(name.replace(/\.jpg$/, ""));
    // Loudly: a karting fixture missing from `SOURCES` would otherwise lower
    // the denominator without saying so, and the sweep would report a band
    // measured on fewer photographs than it names.
    if (annotation === undefined) {
      throw new Error(`${name} is a kart fixture that SOURCES does not record`);
    }
    const composed = kartUnion(annotation, threshold);
    const at = composed === undefined ? 0 : iou(composed.subject, subject);
    if (at >= REPRODUCES) reproduced++;
    if (at < worst.iou) worst = { iou: at, name };
  }
  return { reproduced, worst };
}

function sweep(recorded: Map<string, Annotation>): void {
  console.log(`\noverlap sweep, ${KART_FIXTURES.length} karting fixtures`);
  console.log("threshold  reproduced  worst IoU  worst fixture");
  for (let i = 1; i < 20; i++) {
    const threshold = i / 20;
    const { reproduced, worst } = score(recorded, threshold);
    console.log(
      `${threshold.toFixed(2).padEnd(10)} ${`${reproduced}/${KART_FIXTURES.length}`.padEnd(11)} ${worst.iou.toFixed(4).padEnd(10)} ${worst.name}`
    );
  }

  // The grid above is for reading; this is the finding. Every threshold that
  // reproduces every one of them, at the resolution the recordings carry, so
  // the constant can be judged by where it sits in that band rather than by
  // whether one grid point happened to land on it.
  const all = [];
  for (let i = 1; i < 1000; i++) {
    const threshold = i / 1000;
    if (score(recorded, threshold).reproduced === KART_FIXTURES.length) {
      all.push(threshold);
    }
  }
  console.log(
    all.length === 0
      ? "\nno threshold reproduces every one of them"
      : `\nall ${KART_FIXTURES.length} reproduced for ${all[0]!.toFixed(3)} <= t <= ${all.at(-1)!.toFixed(3)}`
  );
}

// ---------------------------------------------------------------------------

const expected = await catalogueKeys();
console.log(`catalogue: ${expected.join(", ")}`);

const recorded = new Map<string, Annotation>();
for (const [name, relative] of Object.entries(SOURCES)) {
  const annotation = await annotate(resolve(__SOURCES__, relative));

  // The refusal this script exists to make: a recording that does not name the
  // Catalogue it was made against is not a recording of this build.
  const named = annotation.producedBy.map(modelKey);
  const missing = expected.filter((key) => !named.includes(key));
  const extra = named.filter((key) => !expected.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    console.error(
      `${name}: producedBy is ${named.join(", ") || "(empty)"}, catalogue is ${expected.join(", ")}`
    );
    process.exit(1);
  }

  recorded.set(name, annotation);
  console.log(`${name}: ${annotation.regions.length} regions`);
}

for (const [name, annotation] of recorded) {
  await writeFile(
    resolve(__RECORDINGS__, `${name}.json`),
    `${JSON.stringify(annotation, null, 2)}\n`
  );
}
console.log(`wrote ${recorded.size} recordings to ${__RECORDINGS__}`);

sweep(recorded);
