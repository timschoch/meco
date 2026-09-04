/**
 * Measure what a 12 MP photo costs meco-faces, cold and warm.
 *
 * The number that matters to a scale-to-zero container is not the cost of the
 * inference call. It is what a caller waits for when nothing is running: boot,
 * model load, decode and detect, end to end. Measuring that needs the clock to
 * start before the service does, so the script can start the service itself —
 * pass the command after `--` and the stopwatch begins with it.
 *
 * Warm is the median of the requests after that: one photo on a container that
 * is already up, timed twice — once for `/detect` and once for `/embed` on the
 * faces that detect just found.
 *
 * ```
 * tsx scripts/latency.ts http://localhost:8788 10 -- \
 *   docker run --rm -p 8788:80 -e PORT=80 -e MECO_TOKEN=$MECO_TOKEN meco-faces
 * ```
 *
 * Without a command it measures against whatever is already listening, in which
 * case the first number is a first request, not a cold start. `MECO_TOKEN` is
 * sent when it is set, because a deployed service requires it.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const [urlArg, runsArg] = split === -1 ? argv : argv.slice(0, split);
const command = split === -1 ? [] : argv.slice(split + 1);

const base = (urlArg ?? "http://localhost:8788").replace(/\/$/, "");
const runs = Number(runsArg ?? 10);
const token = process.env.MECO_TOKEN;

/**
 * A 12 MP photo, made by enlarging a fixture rather than committing one.
 *
 * The group fixture rather than the portrait, because four faces in one frame
 * is what makes the marginal cost of a face measurable: embedding one and
 * embedding all of them differ only by the extra warps and the extra rows of a
 * batched inference, so the difference between the two numbers is that cost and
 * everything they share is the decode.
 *
 * What is being measured is a decode plus a fixed-size resize, and neither
 * cares whether the detail is real — but 12 MP of real photograph would be
 * megabytes of repository for a number nobody reads twice.
 */
const source = fileURLToPath(
  new URL("../../../fixtures/faces/artemis-2-crew.jpg", import.meta.url),
);
const photo = await sharp(await readFile(source))
  .resize({ width: 3000, height: 4000, fit: "fill" })
  .jpeg({ quality: 90 })
  .toBuffer();

console.log(`photo:  3000x4000 (12.0 MP), ${(photo.length / 1e6).toFixed(1)} MB JPEG`);
console.log(`target: ${base}`);
console.log(`start:  ${command.length > 0 ? command.join(" ") : "(already running)"}\n`);

const headers = {
  "content-type": "image/jpeg",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

async function post(path: string): Promise<{ ms: number; body: unknown }> {
  const started = performance.now();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: new Uint8Array(photo),
  });
  if (!res.ok) throw new Error(`${String(res.status)} ${await res.text()}`);
  const body: unknown = await res.json();
  return { ms: performance.now() - started, body };
}

async function detect(): Promise<{ ms: number; faces: unknown[] }> {
  const { ms, body } = await post("/detect");
  return { ms, faces: (body as { faces: unknown[] }).faces };
}

/**
 * Embedding costs what the *faces* cost, not what the photograph costs, so the
 * faces `/detect` just found are sent straight back rather than a fixed number
 * of them. One warp and one inference each, in a single batched run.
 */
async function embed(faces: unknown[]): Promise<{ ms: number; prints: number }> {
  const { ms, body } = await post(`/embed?faces=${encodeURIComponent(JSON.stringify(faces))}`);
  return { ms, prints: (body as { prints: unknown[] }).prints.length };
}

const t0 = performance.now();
const child =
  command.length > 0
    ? spawn(command[0]!, command.slice(1), { stdio: "ignore" })
    : undefined;

// Keep asking until something answers. A refused connection while the service
// is still booting is part of the wait, not an error.
let cold: number | undefined;
let attempts = 0;
while (cold === undefined) {
  attempts++;
  try {
    await detect();
    cold = performance.now() - t0;
  } catch {
    if (performance.now() - t0 > 120_000) {
      child?.kill();
      throw new Error(`${base} never answered.`);
    }
    await delay(20);
  }
}
console.log(`cold  ${cold.toFixed(0).padStart(6)} ms   (${String(attempts)} attempts from t=0)`);

const warmDetect: number[] = [];
const warmOne: number[] = [];
const warmAll: number[] = [];
let count = 0;
for (let i = 0; i < runs; i++) {
  const { ms, faces } = await detect();
  warmDetect.push(ms);
  count = faces.length;

  // One face and then all of them, on the same photograph. Both pay the same
  // decode, so the gap between them is what a face costs.
  const one = await embed(faces.slice(0, 1));
  const all = await embed(faces);
  warmOne.push(one.ms);
  warmAll.push(all.ms);

  console.log(
    `warm  detect ${ms.toFixed(0).padStart(5)} ms   ` +
      `embed 1 ${one.ms.toFixed(0).padStart(5)} ms   ` +
      `embed ${String(all.prints)} ${all.ms.toFixed(0).padStart(5)} ms`,
  );
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const report = (label: string, values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  console.log(
    `warm ${label} median ${median(values).toFixed(0)} ms, ` +
      `min ${(sorted[0] ?? 0).toFixed(0)} ms, max ${(sorted.at(-1) ?? 0).toFixed(0)} ms ` +
      `over ${String(runs)} runs`,
  );
};

console.log();
report("detect", warmDetect);
report("embed 1 face", warmOne);
report(`embed ${String(count)} faces`, warmAll);
if (count > 1) {
  const perFace = (median(warmAll) - median(warmOne)) / (count - 1);
  console.log(
    `\na further face costs ${perFace.toFixed(1)} ms; the other ` +
      `${median(warmOne).toFixed(0)} ms of an embed is the decode and the round trip`,
  );
}

// A spawned child keeps the event loop alive on its own, so the exit is
// explicit. Killing `docker run` does not always stop the container it started —
// give it `--rm --name` and remove it afterwards.
child?.kill();
process.exit(0);
