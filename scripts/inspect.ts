/**
 * Sanity-check rendered images without looking at them.
 *
 * A render that "succeeded" can still be a blank canvas — a missing font, an
 * image that failed to decode, a layout that collapsed. Channel statistics
 * catch that: a real design has spread in every channel and more than a handful
 * of distinct colours.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import sharp from "sharp";

const dir = process.argv[2] ?? "out";

async function* walk(d: string): AsyncGenerator<string> {
  for (const entry of await readdir(d, { withFileTypes: true })) {
    const p = join(d, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if ([".png", ".jpg", ".jpeg", ".webp"].includes(extname(p))) yield p;
  }
}

let checked = 0;
let suspicious = 0;

for await (const file of walk(dir)) {
  const buf = await readFile(file);
  const img = sharp(buf);
  const meta = await img.metadata();
  const stats = await img.stats();

  const spreads = stats.channels.map((ch) => ch.max - ch.min);
  const meanSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  // entropy is low for flat images, high for photographic/complex ones
  const flat = meanSpread < 40 || stats.entropy < 1.5;

  if (flat) suspicious++;
  checked++;

  console.log(
    `${flat ? "SUSPECT" : "ok     "} ${file}  ${meta.width}x${meta.height}  ` +
      `spread=${spreads.map((s) => s.toFixed(0)).join("/")}  entropy=${stats.entropy.toFixed(2)}`,
  );
}

console.log(`\n${checked} images checked, ${suspicious} suspicious`);
if (suspicious > 0) process.exitCode = 1;
