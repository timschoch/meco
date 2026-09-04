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
 * is already up.
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
 * What is being measured is a decode plus a fixed-size resize, and neither
 * cares whether the detail is real — but 12 MP of real photograph would be
 * megabytes of repository for a number nobody reads twice.
 */
const source = fileURLToPath(
  new URL("../../../fixtures/faces/astronaut-portrait.jpg", import.meta.url),
);
const photo = await sharp(await readFile(source))
  .resize({ width: 3000, height: 4000, fit: "fill" })
  .jpeg({ quality: 90 })
  .toBuffer();

console.log(`photo:  3000x4000 (12.0 MP), ${(photo.length / 1e6).toFixed(1)} MB JPEG`);
console.log(`target: ${base}`);
console.log(`start:  ${command.length > 0 ? command.join(" ") : "(already running)"}\n`);

async function detect(): Promise<{ ms: number; faces: number }> {
  const started = performance.now();
  const res = await fetch(`${base}/detect`, {
    method: "POST",
    headers: {
      "content-type": "image/jpeg",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: new Uint8Array(photo),
  });
  if (!res.ok) throw new Error(`${String(res.status)} ${await res.text()}`);
  const body = (await res.json()) as { faces: unknown[] };
  return { ms: performance.now() - started, faces: body.faces.length };
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

const warm: number[] = [];
for (let i = 0; i < runs; i++) {
  const { ms, faces } = await detect();
  warm.push(ms);
  console.log(`warm  ${ms.toFixed(0).padStart(6)} ms   ${String(faces)} faces`);
}

const sorted = [...warm].sort((a, b) => a - b);
console.log(
  `\nwarm median ${(sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(0)} ms, ` +
    `min ${(sorted[0] ?? 0).toFixed(0)} ms, max ${(sorted.at(-1) ?? 0).toFixed(0)} ms ` +
    `over ${String(runs)} runs`,
);

// A spawned child keeps the event loop alive on its own, so the exit is
// explicit. Killing `docker run` does not always stop the container it started —
// give it `--rm --name` and remove it afterwards.
child?.kill();
process.exit(0);
