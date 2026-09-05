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
 * Face Prints against two photographs of one human being.
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
  applyMatrix,
  asPoints,
  inPixels,
  similarityTransform,
} from "../src/align.js";
import { createFacesApp } from "../src/app.js";
import { detectFaces } from "../src/detect.js";
import { PRINT_LENGTH, embedFaces } from "../src/embed.js";
import { LANDMARK_NAMES, type Landmarks, type Point } from "../src/yunet.js";
import { NOT_A_FACE_PRINTS } from "../../../src/not-a-face-prints.js";
import { FIXTURES, atLongEdge, cosineSimilarity, readFixtureFaces } from "./fixture-faces.js";

interface Reference {
  model: string;
  minCosine: number;
  source: { commit: string };
  prints: Record<string, number[]>;
}

const reference = JSON.parse(
  await readFile(`${FIXTURES}edgeface-reference.json`, "utf8"),
) as Reference;

/** Every fixture face, detected once and reused by all four sections below. */
const fixtures = await readFixtureFaces();

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
  for (const name of LANDMARK_NAMES) {
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
  const image = fixtures.find((i) => i.file === "astronaut-portrait.jpg")!;
  const { width, height } = image.upright;
  const marks = inPixels(image.faces[0]!.face.landmarks, width, height);

  const canvas = await markers(asPoints(marks), width, height, 4);
  const square = await alignFace(canvas, marks);
  const matrix = similarityTransform(asPoints(marks), asPoints(ARCFACE_DST));

  let worst = 0;
  for (const name of LANDMARK_NAMES) {
    const want = applyMatrix(matrix, marks[name]);
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
    ...LANDMARK_NAMES.map((name) => {
      const got = applyMatrix(matrix, marks[name]);
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
const identity = new Map<string, string>();

for (const image of fixtures) {
  for (const { name, person, face } of image.faces) {
    identity.set(name, person);

    const square = await alignFace(
      image.upright,
      inPixels(face.landmarks, image.upright.width, image.upright.height),
    );
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
 * ONNX — and are compared with the Face Prints PyTorch produced on the same
 * squares. Anything that changes the model, the preprocessing or the geometry
 * shows up here as a cosine below 1.
 */
console.log(
  `reference: ${reference.model} from otroshi/edgeface@${reference.source.commit.slice(0, 12)}\n`,
);

const prints = new Map<string, number[]>();

for (const image of fixtures) {
  // Every face of one image in a single call, in the order this test holds
  // them — which also exercises the promise the route makes about that order.
  const embedded = await embedFaces(
    await readFile(`${FIXTURES}${image.file}`),
    image.faces.map(({ face }) => face),
  );

  for (const [i, { name }] of image.faces.entries()) {
    const print = embedded[i]!;
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
      `${name} is ${String(PRINT_LENGTH)} floats on the unit sphere`,
      `${String(print.length)} floats, length ${length.toFixed(9)}`,
    );
  }
}

// ------------------------------- the committed Face Prints are still current

/**
 * `face-prints.json` is what meco calibrates its match threshold on, and meco
 * cannot recompute it — the embedder is in this package, not that one. A stale
 * copy would therefore not fail anywhere: meco's sweep would keep reporting a
 * clean separation between numbers no deployed model produces any more. This is
 * the only place that can notice, so it does.
 *
 * The bar is exact equality rather than a cosine, because the file is a
 * recording of this code's output and not an independent measurement of it. The
 * PyTorch comparison above is where tolerance belongs.
 */
{
  const committed = JSON.parse(await readFile(`${FIXTURES}face-prints.json`, "utf8")) as {
    prints: { name: string; person: string; print: number[] }[];
  };
  const byName = new Map(committed.prints.map((p) => [p.name, p]));

  check(
    committed.prints.length === prints.size,
    "face-prints.json holds every fixture face",
    `${String(committed.prints.length)} committed, ${String(prints.size)} embedded`,
  );

  let worst = 0;
  let missing = "";
  let mislabelled = "";
  for (const [name, print] of prints) {
    const stored = byName.get(name);
    if (!stored) {
      missing = name;
      continue;
    }
    if (stored.person !== identity.get(name)) mislabelled = name;
    for (let i = 0; i < print.length; i++) {
      worst = Math.max(worst, Math.abs(print[i]! - stored.print[i]!));
    }
  }
  check(
    missing === "" && mislabelled === "" && worst === 0,
    "face-prints.json is still what the embedder makes",
    missing !== ""
      ? `${missing} is not in it — run pnpm --filter meco-faces dump:prints`
      : mislabelled !== ""
        ? `${mislabelled} carries the wrong person letter`
        : `worst float differs by ${String(worst)}`,
  );
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

// --------------------------------------- what a smaller photograph costs a print

/**
 * Whether a Face Print still names the same face when the photograph was bounded.
 *
 * meco cannot send a Source Image over 4.5 MB — a Vercel Function refuses the
 * body — so it bounds the long edge before `/embed` sees it (issue #30). This is
 * the one place that costs anything real: a print is warped from a 112x112 square
 * of the *face*, so shrinking the photograph first does throw away detail the
 * detector never wanted. The question is whether it throws away identity.
 *
 * It does not, and the measurement is the reason to believe it. A print off the
 * bounded copy sits far nearer its own full-size print than any other face's, and
 * the gap is not close: a match is decided at a cosine of 0.5 in meco, and the
 * two populations here are separated by an order of magnitude more than the bound
 * moves either of them.
 *
 * The group photograph is the hard case on purpose — four faces at four scales,
 * each about a twelfth of the frame's width, in the one fixture that is genuinely
 * too big to send. At a 1600 px long edge the smallest of them is ~100 px across,
 * just under the 112 px template, so the warp is upsampling by the time the cap
 * bites.
 */
const fullSize = await readFile(`${FIXTURES}artemis-2-crew-full.jpg`);
const atFullSize = await detectFaces(fullSize);

check(
  atFullSize.faces.length === 4,
  "the group photograph at full size has four faces to embed",
  `${String(atFullSize.faces.length)} found in ${String(atFullSize.width)}x${String(atFullSize.height)}`,
);

if (atFullSize.faces.length === 4) {
  const landmarks = atFullSize.faces.map((face) => ({ landmarks: face.landmarks }));
  const full = await embedFaces(fullSize, landmarks);

  for (const longEdge of [2048, 1600, 1280]) {
    const smaller = await atLongEdge(fullSize, longEdge);
    // The same landmarks, not re-detected ones: the question is what the resize
    // does to the *pixels* the warp reads. Detection is measured in the detect
    // test, and mixing the two would blur which of them had moved.
    const bounded = await embedFaces(smaller, landmarks);

    const mine = bounded.map((print, i) => cosineSimilarity(print, full[i]!));
    const others = bounded.flatMap((print, i) =>
      full.filter((_, j) => j !== i).map((other) => cosineSimilarity(print, other)),
    );
    const worstMine = Math.min(...mine);
    const bestOther = Math.max(...others);

    check(
      worstMine > bestOther + 0.5,
      `a print off the ${String(longEdge)} px copy is still that face's print`,
      `own face ${worstMine.toFixed(4)} at worst, any other face ${bestOther.toFixed(4)} at best`,
    );
  }
}

// ------------------------------------------------- the kart prints meco ships

/**
 * The committed kart numbers still are what this model produces.
 *
 * Three files are generated from these fixtures by `pnpm dump:karts` and then
 * committed: `fixtures/karts/detected.json`, `fixtures/karts/face-prints.json`
 * and `src/not-a-face-prints.ts`. meco reads the last of those to decide whether
 * a Face Print is an identity at all, and it cannot check the number itself —
 * ADR-0002 keeps ONNX Runtime out of its dependency tree, so nothing over there
 * can tell a current print from a stale one.
 *
 * That makes this the only place the check can live, and it is worth more than
 * housekeeping. A swapped or re-exported embedder would move every print at
 * once; meco would go on comparing new prints against an old one, find nothing
 * alike, and quietly stop refusing helmets. The failure would be silent and in
 * the dangerous direction. So the fixtures are re-embedded here and the
 * committed numbers have to still match, to the last float.
 *
 * Reading meco's source from this package is the thing to justify, and the
 * justification is that this is a script rather than the service: nothing in
 * `packages/faces/src/` learns anything about its caller, exactly as
 * `fixture-faces.ts` reads `fixtures/` without the detector knowing.
 */
{
  const KARTS = fileURLToPath(new URL("../../../fixtures/karts/", import.meta.url));
  const committed = JSON.parse(await readFile(`${KARTS}face-prints.json`, "utf8")) as {
    prints: { file: string; index: number; label: string; reference: boolean; print: number[] }[];
  };

  let worstDrift = 0;
  let stale = "";
  for (const entry of committed.prints) {
    const bytes = await readFile(`${KARTS}${entry.file}`);
    const detected = await detectFaces(bytes);
    const face = detected.faces[entry.index];
    if (!face) {
      stale = `${entry.file}#${String(entry.index)} is no longer detected`;
      break;
    }
    const [fresh] = await embedFaces(bytes, [{ landmarks: face.landmarks }]);
    const drift = Math.max(...entry.print.map((v, i) => Math.abs(v - fresh![i]!)));
    worstDrift = Math.max(worstDrift, drift);
    if (drift > 1e-6) {
      stale = `${entry.file}#${String(entry.index)} moved by ${drift.toFixed(8)}`;
      break;
    }
  }
  check(
    stale === "",
    "every committed kart Face Print is still what the model returns",
    stale === ""
      ? `${String(committed.prints.length)} prints, worst float off by ${worstDrift.toExponential(1)}`
      : `${stale} — re-run \`pnpm dump:karts\` and re-read scripts/match-calibration.ts`,
  );

  // The one print meco actually ships, checked as itself and not only as a row
  // in the file it was cut from. These are two artefacts and a regeneration that
  // wrote one and not the other is exactly the drift this is here to catch.
  let shipped = "";
  for (const reference of NOT_A_FACE_PRINTS) {
    const [file, index] = reference.name.split("#") as [string, string];
    const source = committed.prints.find(
      (p) => p.file === file && p.index === Number(index) && p.reference,
    );
    if (!source) {
      shipped = `${reference.name} is not a reference in fixtures/karts/face-prints.json`;
      break;
    }
    const drift = Math.max(...source.print.map((v, i) => Math.abs(v - reference.print[i]!)));
    if (drift > 1e-12) {
      shipped = `${reference.name} differs from its fixture by ${drift.toFixed(12)}`;
      break;
    }
  }
  check(
    shipped === "",
    "and src/not-a-face-prints.ts holds exactly the ones marked reference",
    shipped === ""
      ? NOT_A_FACE_PRINTS.map((r) => `${r.name} — ${r.what}`).join(", ")
      : shipped,
  );
}

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
  "the API answer is the same Face Print the library produced",
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
