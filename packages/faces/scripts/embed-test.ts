/**
 * Prove a Face Print means the same thing here as it does in PyTorch.
 *
 * Three things can be wrong with an embedder and none of them throws. The warp
 * can put the face somewhere other than the template, in which case every Face
 * Print is of a slightly different framing and none of them match. The ONNX
 * export can quietly change an operator, in which case the numbers are stable
 * but are not the model Idiap trained. And the preprocessing can use the wrong
 * range, in which case everything runs and nothing recognises anyone. Each gets
 * its own section below, and each is checked against something outside this
 * package: geometry against arithmetic, the export against PyTorch, and the
 * embeddings against two photographs of one human being.
 *
 * Drives the Hono app in-process — no port, no container.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  ALIGNED_SIZE,
  ARCFACE_DST,
  alignFace,
  alignmentMatrix,
  applyMatrix,
  asPoints,
  type RawImage,
} from "../src/align.js";
import { createFacesApp } from "../src/app.js";
import { detectFaces } from "../src/detect.js";
import { PRINT_LENGTH, cosineSimilarity, embedFaces } from "../src/embed.js";
import type { Box, Landmarks, Point } from "../src/yunet.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/faces/", import.meta.url));

interface Expected {
  images: { file: string; faces: { label: string; person?: string; box: Box }[] }[];
}

interface Reference {
  model: string;
  minCosine: number;
  source: { commit: string };
  prints: Record<string, number[]>;
}

const expected = JSON.parse(await readFile(`${FIXTURES}expected.json`, "utf8")) as Expected;
const reference = JSON.parse(
  await readFile(`${FIXTURES}edgeface-reference.json`, "utf8"),
) as Reference;

const checks: { ok: boolean; label: string; detail: string }[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  checks.push({ ok, label, detail });
};

// ------------------------------------------------------- the warp, in numbers

/**
 * Where the bright spot in a 112x112 square actually sits, to a fraction of a
 * pixel.
 *
 * Intensity-weighted, and only over pixels near the point being asked about, so
 * that five markers in one square do not average into one answer. Coordinates
 * are pixel indices — the convention libvips, OpenCV and `arcface_dst` all use,
 * and the reason the markers below are drawn half a pixel off in SVG, whose own
 * origin is the corner of a pixel rather than its centre.
 */
function centroid(square: Buffer, near: Point): Point | undefined {
  let sx = 0;
  let sy = 0;
  let weight = 0;
  for (let y = 0; y < ALIGNED_SIZE; y++) {
    for (let x = 0; x < ALIGNED_SIZE; x++) {
      const value = square[(y * ALIGNED_SIZE + x) * 3] ?? 0;
      if (value < 32) continue;
      if (Math.hypot(x - near.x, y - near.y) > 6) continue;
      sx += x * value;
      sy += y * value;
      weight += value;
    }
  }
  return weight === 0 ? undefined : { x: sx / weight, y: sy / weight };
}

/** A black canvas with a white disc on each of the given points. */
async function markers(points: Point[], width: number, height: number, radius: number) {
  const svg =
    `<svg width="${String(width)}" height="${String(height)}">` +
    `<rect width="${String(width)}" height="${String(height)}" fill="black"/>` +
    points
      .map(
        (p) =>
          `<circle cx="${String(p.x + 0.5)}" cy="${String(p.y + 0.5)}" ` +
          `r="${String(radius)}" fill="white"/>`,
      )
      .join("") +
    `</svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  return { data, width: info.width, height: info.height };
}

/**
 * Five landmarks placed by a known similarity transform.
 *
 * Because the arrangement is the template's own, only moved and turned, the
 * least-squares fit has no residual to leave — so the eyes must land on
 * `arcface_dst` exactly, and any distance from it is the implementation's
 * error rather than the face's. That is what makes "within 1 px of the ArcFace
 * reference points" a statement about the warp and not about the photograph.
 */
function placed(scale: number, degrees: number, tx: number, ty: number): Landmarks {
  const radians = (degrees * Math.PI) / 180;
  const a = scale * Math.cos(radians);
  const b = scale * Math.sin(radians);
  const move = (p: Point): Point => ({ x: a * p.x - b * p.y + tx, y: b * p.x + a * p.y + ty });
  return {
    rEye: move(ARCFACE_DST.rEye),
    lEye: move(ARCFACE_DST.lEye),
    nose: move(ARCFACE_DST.nose),
    rMouth: move(ARCFACE_DST.rMouth),
    lMouth: move(ARCFACE_DST.lMouth),
  };
}

const NAMES = ["rEye", "lEye", "nose", "rMouth", "lMouth"] as const;

for (const [scale, degrees, tx, ty] of [
  [3.2, 0, 120, 80],
  [3.2, 17, 300, 160],
  [1.0, 0, 5, 5],
  [0.7, -25, 500, 400],
  [2.1, -140, 400, 300],
] as const) {
  const landmarks = placed(scale, degrees, tx, ty);
  const canvas = await markers(asPoints(landmarks), 900, 700, Math.max(1.5, 2 * scale));
  const square = await alignFace(canvas, landmarks);

  let worst = 0;
  let missing = "";
  for (const name of NAMES) {
    const found = centroid(square, ARCFACE_DST[name]);
    if (!found) {
      missing = name;
      break;
    }
    worst = Math.max(worst, Math.hypot(found.x - ARCFACE_DST[name].x, found.y - ARCFACE_DST[name].y));
  }
  check(
    missing === "" && worst < 1,
    `warp at scale ${String(scale)}, ${String(degrees)} deg`,
    missing === ""
      ? `worst landmark ${worst.toFixed(3)} px from its reference point`
      : `${missing} never arrived in the square`,
  );
}

// The eyes specifically, which is what the ticket names and what the headroom
// rule downstream cares about most.
{
  const landmarks = placed(2.6, 11, 260, 190);
  const canvas = await markers(asPoints(landmarks), 900, 700, 5);
  const square = await alignFace(canvas, landmarks);
  for (const eye of ["rEye", "lEye"] as const) {
    const found = centroid(square, ARCFACE_DST[eye]);
    const off = found
      ? Math.hypot(found.x - ARCFACE_DST[eye].x, found.y - ARCFACE_DST[eye].y)
      : Infinity;
    check(off < 1, `${eye} lands on the reference point`, `${off.toFixed(3)} px away`);
  }
}

// ---------------------------------------------- the warp, on a real face

/**
 * A real face's landmarks are not arranged like the template, so the fit leaves
 * a residual and the eyes are *not* expected to land on `arcface_dst` exactly.
 * What must still hold is that the pixels go where the transform says they go —
 * so the markers are checked against the transform's own prediction rather than
 * against the template.
 */
{
  const bytes = await readFile(`${FIXTURES}astronaut-portrait.jpg`);
  const { faces, width, height } = await detectFaces(bytes);
  const face = faces[0]!;
  const inPixels = Object.fromEntries(
    Object.entries(face.landmarks).map(([name, p]) => [name, { x: p.x * width, y: p.y * height }]),
  ) as unknown as Landmarks;

  const canvas = await markers(asPoints(inPixels), width, height, 4);
  const square = await alignFace(canvas, inPixels);
  const matrix = alignmentMatrix(inPixels);

  let worst = 0;
  for (const name of NAMES) {
    const want = applyMatrix(matrix, inPixels[name]);
    const found = centroid(square, want);
    worst = Math.max(worst, found ? Math.hypot(found.x - want.x, found.y - want.y) : Infinity);
  }
  check(
    worst < 1,
    "a real face's landmarks land where the fit predicts",
    `worst ${worst.toFixed(3)} px`,
  );

  // And the residual itself is worth reporting: a large one would mean the
  // detector's five points are not shaped like a face at all.
  const residual = Math.max(
    ...NAMES.map((name) => {
      const got = applyMatrix(matrix, inPixels[name]);
      return Math.hypot(got.x - ARCFACE_DST[name].x, got.y - ARCFACE_DST[name].y);
    }),
  );
  check(
    residual < 8,
    "the similarity fit is close to the template",
    `worst landmark ${residual.toFixed(2)} px from arcface_dst after fitting`,
  );
}

// -------------------------------------- the aligned fixtures are still current

/**
 * The committed squares in `aligned/` are what the PyTorch reference was
 * computed on. If the aligner no longer produces them, the comparison below is
 * against numbers describing pixels nobody sends any more — so this has to fail
 * loudly rather than let the next section pass on stale evidence.
 *
 * A channel of slack absorbs a rounding change inside libvips's resampler; it
 * is far tighter than any change of geometry could hide behind.
 */
const aligned = new Map<string, { square: Buffer; person: string }>();

for (const image of expected.images) {
  if (image.faces.length === 0) continue;

  const bytes = await readFile(`${FIXTURES}${image.file}`);
  const { faces, width, height } = await detectFaces(bytes);
  if (faces.length !== image.faces.length) {
    check(false, `${image.file} face count`, "the detect test has to pass before this one can");
    continue;
  }

  const marked = [...image.faces].sort((a, b) => a.box.x - b.box.x);
  const found = [...faces].sort((a, b) => a.box.x - b.box.x);
  const upright = await sharp(bytes).rotate().removeAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const raw: RawImage = {
    data: upright.data,
    width: upright.info.width,
    height: upright.info.height,
  };

  for (const [i, face] of found.entries()) {
    const inPixels = Object.fromEntries(
      Object.entries(face.landmarks).map(([name, p]) => [
        name,
        { x: p.x * width, y: p.y * height },
      ]),
    ) as unknown as Landmarks;

    const square = await alignFace(raw, inPixels);
    const name = `${image.file.replace(/\.[a-z]+$/, "")}-${marked[i]!.label.replace(/\s+/g, "-")}.png`;
    aligned.set(name, { square, person: marked[i]!.person ?? "?" });

    const committed = await sharp(`${FIXTURES}aligned/${name}`).removeAlpha().raw().toBuffer();
    let worst = 0;
    for (let b = 0; b < committed.length; b++) {
      worst = Math.max(worst, Math.abs(committed[b]! - square[b]!));
    }
    check(
      worst <= 1,
      `aligned/${name} is still what the aligner makes`,
      `worst channel differs by ${String(worst)}`,
    );
  }
}

// --------------------------------------------- the export agrees with PyTorch

/**
 * The acceptance criterion, and the reason `export-edgeface.py` exists.
 *
 * The Face Prints come out of the whole service path — decode, detect, warp,
 * ONNX — and are compared with vectors the PyTorch model produced on the same
 * squares. Anything that changes the model, the preprocessing or the geometry
 * shows up here as a cosine below 1.
 */
console.log(
  `reference: ${reference.model} from otroshi/edgeface@${reference.source.commit.slice(0, 12)}\n`,
);

const prints = new Map<string, number[]>();

for (const image of expected.images) {
  if (image.faces.length === 0) continue;

  const bytes = await readFile(`${FIXTURES}${image.file}`);
  const { faces } = await detectFaces(bytes);
  const marked = [...image.faces].sort((a, b) => a.box.x - b.box.x);
  const order = faces
    .map((face, index) => ({ face, index }))
    .sort((a, b) => a.face.box.x - b.face.box.x);

  const embedded = await embedFaces(bytes, faces);
  for (const [i, { index }] of order.entries()) {
    const name = `${image.file.replace(/\.[a-z]+$/, "")}-${marked[i]!.label.replace(/\s+/g, "-")}.png`;
    const print = embedded[index]!;
    prints.set(name, print);

    const want = reference.prints[name];
    if (!want) {
      check(false, `${name} has a PyTorch reference`, "re-run scripts/export-edgeface.py");
      continue;
    }
    const cosine = cosineSimilarity(print, want);
    check(
      cosine > reference.minCosine,
      `${name} matches PyTorch`,
      `cosine ${cosine.toFixed(6)} (needs > ${String(reference.minCosine)})`,
    );

    const length = Math.sqrt(print.reduce((sum, v) => sum + v * v, 0));
    check(
      print.length === PRINT_LENGTH && Math.abs(length - 1) < 1e-6,
      `${name} is a unit vector of ${String(PRINT_LENGTH)} floats`,
      `${String(print.length)} floats, length ${length.toFixed(9)}`,
    );
  }
}

// ------------------------------------------- same person, and different people

/**
 * What the numbers actually are, on faces whose identities are known.
 *
 * The two thresholds here are the ticket's, and they are a sanity floor rather
 * than an operating point: the real match threshold is calibrated on enrolled
 * photographs in the matching ticket, and this test exists to catch a
 * catastrophically wrong pipeline, not to tune the model. So the measurements
 * are printed whether they pass or fail.
 */
const identity = new Map<string, string>();
for (const [name, { person }] of aligned) identity.set(name, person);

const pairs: { a: string; b: string; same: boolean; cosine: number }[] = [];
const names = [...prints.keys()].sort();
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const a = names[i]!;
    const b = names[j]!;
    pairs.push({
      a,
      b,
      same: identity.get(a) === identity.get(b),
      cosine: cosineSimilarity(prints.get(a)!, prints.get(b)!),
    });
  }
}

console.log("cosine similarity between every pair of fixture faces:");
for (const pair of [...pairs].sort((x, y) => y.cosine - x.cosine)) {
  console.log(
    `  ${pair.same ? "same  " : "differ"} ${pair.cosine.toFixed(4)}  ` +
      `${pair.a.replace(".png", "")} / ${pair.b.replace(".png", "")}`,
  );
}
console.log();

const same = pairs.filter((p) => p.same);
const different = pairs.filter((p) => !p.same);
check(same.length > 0, "there is a same-person pair to measure", `${String(same.length)} pairs`);
check(
  same.every((p) => p.cosine > 0.5),
  "the same person in two photographs scores above 0.5",
  same.map((p) => p.cosine.toFixed(4)).join(", "),
);
check(
  different.every((p) => p.cosine < 0.3),
  "two different people score below 0.3",
  `worst ${Math.max(...different.map((p) => p.cosine)).toFixed(4)} over ${String(different.length)} pairs`,
);

// ------------------------------------------------------------------- the API

const TOKEN = "embed-test-token";
const app = createFacesApp(TOKEN);
const photo = await readFile(`${FIXTURES}astronaut-portrait.jpg`);
const detected = await detectFaces(photo);
const query = encodeURIComponent(JSON.stringify(detected.faces));

const post = (headers: Record<string, string>, path = "/embed", search = `?faces=${query}`) =>
  app.fetch(
    new Request(`http://local${path}${search}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", ...headers },
      body: new Uint8Array(photo),
    }),
  );

const authorised = { authorization: `Bearer ${TOKEN}` };

const anonymous = await post({});
check(anonymous.status === 401, "POST /embed without a token", `status ${String(anonymous.status)}`);

const prefixedAnonymous = await post({}, "/faces/embed");
check(
  prefixedAnonymous.status === 401,
  "POST /faces/embed without a token",
  `status ${String(prefixedAnonymous.status)}`,
);

const ok = await post(authorised);
const body = (await ok.json()) as { prints: number[][] };
check(
  ok.status === 200 && body.prints.length === 1 && body.prints[0]!.length === PRINT_LENGTH,
  "POST /embed returns one Face Print per face",
  `status ${String(ok.status)}, ${String(body.prints.length)} prints`,
);
check(
  cosineSimilarity(body.prints[0]!, prints.get("astronaut-portrait-centre.png")!) > 0.999999,
  "the route and the function agree",
  "the API answer is the same vector the library produced",
);

const prefixed = await post(authorised, "/faces/embed");
check(prefixed.status === 200, "POST /faces/embed with a token", `status ${String(prefixed.status)}`);

const empty = await app.fetch(
  new Request(`http://local/embed?faces=${query}`, { method: "POST", headers: authorised }),
);
check(empty.status === 400, "POST /embed with no body", `status ${String(empty.status)}`);

for (const [label, search] of [
  ["no faces parameter", ""],
  ["faces that are not JSON", "?faces=not-json"],
  ["faces that are not an array", `?faces=${encodeURIComponent('{"landmarks":{}}')}`],
  [
    "a face missing a landmark",
    `?faces=${encodeURIComponent(
      JSON.stringify([{ landmarks: { rEye: { x: 0.4, y: 0.2 }, lEye: { x: 0.5, y: 0.2 } } }]),
    )}`,
  ],
] as const) {
  const bad = await post(authorised, "/embed", search);
  check(bad.status === 400, `POST /embed with ${label}`, `status ${String(bad.status)}`);
}

const none = await post(authorised, "/embed", `?faces=${encodeURIComponent("[]")}`);
const noneBody = (await none.json()) as { prints: number[][] };
check(
  none.status === 200 && noneBody.prints.length === 0,
  "POST /embed with no faces returns no prints",
  `status ${String(none.status)}, ${String(noneBody.prints.length)} prints`,
);

const health = await app.fetch(new Request("http://local/health"));
const reported = (await health.json()) as { models: { name: string; warm: boolean }[] };
check(
  health.status === 200 && reported.models.some((m) => m.name === "edgeface"),
  "GET /health names EdgeFace",
  reported.models.map((m) => `${m.name}${m.warm ? " (warm)" : ""}`).join(", "),
);

// ------------------------------------------------------------------ the tally

for (const c of checks) {
  console.log(`${c.ok ? "ok    " : "FAIL  "} ${c.label.padEnd(52)} ${c.detail}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${String(checks.length)} checks, ${String(failed.length)} failed`);
if (failed.length > 0) process.exitCode = 1;
