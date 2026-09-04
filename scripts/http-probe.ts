/**
 * Drive the meco HTTP API in-process and check what comes back.
 *
 * The solver test proves the arithmetic; this proves the whole crop path — the
 * request schema, the producers reading a real photograph, sharp cutting the
 * window, storage filing it, and the Gallery finding it again. Nothing here
 * listens on a port or reaches the network: `createApp` hands back a fetch
 * handler, Storage writes to a temp directory that is deleted at the end, and
 * the Source Image travels as a `data:` URL, so the run is the same everywhere.
 *
 * Same shape as `scripts/mcp-probe.ts`: one line per check, non-zero exit when
 * any of them failed.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import { createApp } from "../src/app.js";
import { CROP_PRODUCERS } from "../src/crop-solver.js";
import { LocalStorage } from "../src/storage.js";

const problems: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok    " : "FAIL  "}${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) problems.push(name);
}

/**
 * The probe owns its environment rather than inheriting it: a token set in the
 * shell would otherwise turn every call into a 401, and pinning one here means
 * the auth the container runs with is on the path being tested.
 */
const TOKEN = "probe-token";
process.env.MECO_TOKEN = TOKEN;

const root = await mkdtemp(join(tmpdir(), "meco-http-"));
const storage = new LocalStorage(root, "http://local");
const app = createApp(storage);

// ------------------------------------------------------------------ fixtures

/** A photograph with somewhere obvious to look, so saliency has an answer. */
async function photo(width: number, height: number): Promise<string> {
  const subject = await sharp({
    create: {
      width: Math.round(width / 8),
      height: Math.round(width / 8),
      channels: 3,
      background: { r: 236, g: 198, b: 168 },
    },
  })
    .png()
    .toBuffer();

  const data = await sharp({
    create: { width, height, channels: 3, background: { r: 22, g: 32, b: 44 } },
  })
    .composite([
      { input: subject, left: Math.round(width * 0.62), top: Math.round(height * 0.2) },
    ])
    .jpeg({ quality: 80 })
    .toBuffer();

  return `data:image/jpeg;base64,${data.toString("base64")}`;
}

const LANDSCAPE = await photo(1600, 1000);
/** Exactly 9:16, so a 9:16 request needs no crop and sharp reports no point. */
const EXACT_9_16 = await photo(540, 960);

// ------------------------------------------------------------------- driving

interface Json {
  [key: string]: unknown;
}

async function post(path: string, body: Json): Promise<{ status: number; json: Json }> {
  const res = await app.fetch(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-auth-token": TOKEN },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Json };
}

async function get(path: string): Promise<{ status: number; json: Json }> {
  const res = await app.fetch(
    new Request(`http://local${path}`, { headers: { "x-auth-token": TOKEN } }),
  );
  return { status: res.status, json: (await res.json()) as Json };
}

/** The size the stored bytes really have, not the size the response claims. */
async function storedSize(key: unknown): Promise<string> {
  const meta = await sharp(await readFile(join(root, String(key)))).metadata();
  return `${String(meta.width)}x${String(meta.height)}`;
}

// --------------------------------------------------------------------- crops

console.log("crop");

interface CropCase {
  label: string;
  body: Json;
  resolvedBy: string;
  anchor?: string;
}

const CASES: CropCase[] = [
  {
    label: "a Crop Anchor",
    body: { source: LANDSCAPE, width: 1080, height: 1350, anchor: "top" },
    resolvedBy: "anchor",
    anchor: "top",
  },
  {
    label: "attention",
    body: { source: LANDSCAPE, width: 1080, height: 1920, strategy: "attention" },
    resolvedBy: "saliency",
  },
  {
    label: "entropy",
    body: { source: LANDSCAPE, width: 1080, height: 1080, strategy: "entropy" },
    resolvedBy: "saliency",
  },
  {
    label: "neither",
    body: { source: LANDSCAPE, width: 1200, height: 627 },
    resolvedBy: "centre",
  },
  {
    label: "png at a wide shape",
    body: { source: LANDSCAPE, width: 1920, height: 1080, format: "png", anchor: "bottom-right" },
    resolvedBy: "anchor",
    anchor: "bottom-right",
  },
  // An exact-aspect request leaves libvips nothing to crop, so no saliency point
  // comes back and the Crop Anchor has to answer instead.
  {
    label: "attention with nothing to crop",
    body: { source: EXACT_9_16, width: 1080, height: 1920, strategy: "attention", anchor: "left" },
    resolvedBy: "anchor",
    anchor: "left",
  },
];

for (const one of CASES) {
  const { status, json } = await post("/v1/crop", one.body);
  const wanted = `${String(one.body.width)}x${String(one.body.height)}`;
  check(`${one.label} returned 200`, status === 200, JSON.stringify(json).slice(0, 200));
  if (status !== 200) continue;
  check(
    `${one.label} returned the size asked for`,
    `${String(json.width)}x${String(json.height)}` === wanted,
    `wanted ${wanted}`,
  );
  check(
    `${one.label} stored an image of that size`,
    (await storedSize(json.key)) === wanted,
    await storedSize(json.key),
  );
  check(
    `${one.label} named the producer that framed it`,
    json.resolvedBy === one.resolvedBy,
    `resolvedBy=${String(json.resolvedBy)}`,
  );
  check(
    `${one.label} named a producer that exists`,
    CROP_PRODUCERS.includes(json.resolvedBy as never),
  );
  check(
    `${one.label} reported whether the Subject was held`,
    typeof json.satisfied === "boolean",
    `satisfied=${String(json.satisfied)}`,
  );
  if (one.anchor) {
    check(`${one.label} echoed the Crop Anchor`, json.anchor === one.anchor);
  }
}

const rejected = await post("/v1/crop", { source: LANDSCAPE, width: 0, height: 100 });
check("a Crop of no size is refused", rejected.status === 400, String(rejected.status));

const dead = await post("/v1/crop", { source: "not-a-url", width: 100, height: 100 });
check("a source that is not a URL is refused", dead.status === 400, String(dead.status));

// ------------------------------------------------------------------- gallery

console.log("\ngallery");

const listing = await get("/v1/gallery");
const items = (listing.json.items ?? []) as { kind: string; key: string }[];
check("the Gallery answered", listing.status === 200);
check(
  "the Gallery listed every Crop just stored",
  items.filter((i) => i.kind === "crop").length === CASES.length,
  `${String(items.length)} items`,
);
check(
  "every listed Crop is content-addressed under crops/",
  items.every((i) => i.kind !== "crop" || /^crops\/[0-9a-f]{32}\.\w+$/.test(i.key)),
);

const byBrand = await get("/v1/gallery?brand=laica");
check(
  "a Brand filter leaves Crops out, since a Crop has no Brand",
  ((byBrand.json.items ?? []) as { kind: string }[]).every((i) => i.kind !== "crop"),
);

const nonsense = await get("/v1/gallery?brand=nobody");
check("an unknown Brand is refused", nonsense.status === 400, String(nonsense.status));

const anonymous = await app.fetch(new Request("http://local/v1/gallery"));
check("a call with no token is refused", anonymous.status === 401, String(anonymous.status));

await rm(root, { recursive: true, force: true });

console.log(
  `\n${problems.length === 0 ? "HTTP OK" : `${String(problems.length)} FAILED`}`,
);
if (problems.length > 0) process.exitCode = 1;
