/**
 * Prove a render is not blank, without looking at it.
 *
 * Entropy is the wrong test: a deliberately flat, minimal slide is low-entropy
 * and so is an empty canvas. What separates them is *ink* — the share of pixels
 * that differ from the dominant background colour, and how far down the canvas
 * that ink is spread. A blank slide has almost none; a slide with a headline,
 * body text and a logo has a few percent spread over several bands.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import sharp from "sharp";

const dir = process.argv[2] ?? "out";
/** A render must have at least this share of non-background pixels. */
const MIN_INK = 0.004;
/** Ink must appear in at least this many of the 8 horizontal bands. */
const MIN_BANDS = 2;

async function* walk(d: string): AsyncGenerator<string> {
  for (const entry of await readdir(d, { withFileTypes: true })) {
    const p = join(d, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if ([".png", ".jpg", ".jpeg", ".webp"].includes(extname(p))) yield p;
  }
}

interface Result {
  file: string;
  width: number;
  height: number;
  ink: number;
  bands: number;
  ok: boolean;
}

const results: Result[] = [];

for await (const file of walk(dir)) {
  const buf = await readFile(file);
  // Downscale: we are measuring coverage, not inspecting detail.
  const { data, info } = await sharp(buf)
    .resize({ width: 200, fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;

  // Dominant colour = the background.
  const hist = new Map<string, number>();
  for (let i = 0; i < data.length; i += channels) {
    const key = `${data[i]! >> 4},${data[i + 1]! >> 4},${data[i + 2]! >> 4}`;
    hist.set(key, (hist.get(key) ?? 0) + 1);
  }
  const [dr, dg, db] = [...hist.entries()]
    .sort((a, b) => b[1] - a[1])[0]![0]
    .split(",")
    .map((n) => (Number(n) << 4) + 8);

  const bandCount = 8;
  const bandInk = new Array(bandCount).fill(0);
  let ink = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const dist =
        Math.abs(data[i]! - dr!) + Math.abs(data[i + 1]! - dg!) + Math.abs(data[i + 2]! - db!);
      if (dist > 90) {
        ink++;
        bandInk[Math.min(bandCount - 1, Math.floor((y / height) * bandCount))]++;
      }
    }
  }

  const total = width * height;
  const inkShare = ink / total;
  const bands = bandInk.filter((n) => n / (total / bandCount) > 0.002).length;
  const meta = await sharp(buf).metadata();

  results.push({
    file: relative(dir, file),
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    ink: inkShare,
    bands,
    ok: inkShare >= MIN_INK && bands >= MIN_BANDS,
  });
}

results.sort((a, b) => a.ink - b.ink);

for (const r of results) {
  console.log(
    `${r.ok ? "ok    " : "BLANK?"} ink=${(r.ink * 100).toFixed(2).padStart(5)}%  ` +
      `bands=${r.bands}/8  ${String(r.width)}x${String(r.height)}  ${r.file}`,
  );
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length} renders checked, ${bad.length} look blank`);
if (bad.length > 0) process.exitCode = 1;
