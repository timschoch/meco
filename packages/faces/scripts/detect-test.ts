/**
 * Prove meco-faces finds the faces a human finds, and refuses the rest.
 *
 * A face detector is easy to write and easy to get subtly wrong: swap the two
 * outer colour channels, offset the landmarks from the box centre instead of
 * the cell corner, or forget that the padding goes on the bottom and right, and
 * it still returns plausible-looking rectangles — just not around the faces.
 * The only test that catches any of that is one that compares the output to
 * boxes a person drew, on photographs with known contents.
 *
 * Drives the Hono app in-process — no port, no container. That is also what
 * makes the token check testable here rather than only against a deployment.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { createFacesApp } from "../src/app.js";
import { detectFaces, type Face } from "../src/detect.js";
import { type Box } from "../src/yunet.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/faces/", import.meta.url));

interface Expectation {
  file: string;
  note: string;
  faces: { label: string; box: Box }[];
}

interface Expected {
  tolerance: number;
  images: Expectation[];
}

const expected = JSON.parse(await readFile(`${FIXTURES}expected.json`, "utf8")) as Expected;

const checks: { ok: boolean; label: string; detail: string }[] = [];

const check = (ok: boolean, label: string, detail = "") => {
  checks.push({ ok, label, detail });
};

/** How far apart two boxes are, as the worst of their four coordinates. */
const deviation = (a: Box, b: Box) =>
  Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height),
  );

// -------------------------------------------------------------- the fixtures

for (const image of expected.images) {
  const bytes = await readFile(`${FIXTURES}${image.file}`);
  const result = await detectFaces(bytes);
  const found = result.faces.length;
  const want = image.faces.length;

  check(
    found === want,
    `${image.file} face count`,
    `expected ${String(want)}, found ${String(found)} — ${image.note}`,
  );
  if (found !== want) continue;

  // Detections come back strongest first, not left to right, so each
  // hand-marked face claims the detection nearest to it rather than the one at
  // the same index. A detection may only be claimed once: two expectations
  // collapsing onto one box is exactly the duplicate-suppression bug that would
  // otherwise pass.
  const unclaimed = new Set<Face>(result.faces);
  for (const { label, box } of image.faces) {
    let best: Face | undefined;
    let bestBy = Infinity;
    for (const face of unclaimed) {
      const d = deviation(box, face.box);
      if (d < bestBy) {
        bestBy = d;
        best = face;
      }
    }
    if (best) unclaimed.delete(best);
    check(
      bestBy <= expected.tolerance,
      `${image.file} ${label}`,
      `worst coordinate off by ${bestBy.toFixed(4)} (allowed ${expected.tolerance.toFixed(2)})` +
        `, score ${(best?.score ?? 0).toFixed(3)}`,
    );
  }

  // The eyes drive the headroom rule a Crop applies, so a landmark that is
  // merely somewhere on the face is not good enough: it has to sit in the top
  // three fifths of its own box, and the right eye has to be left of the left
  // eye — "right" being the subject's right, which is the viewer's left.
  for (const face of result.faces) {
    const { rEye, lEye } = face.landmarks;
    const inUpperHalf = (y: number) =>
      y > face.box.y && y < face.box.y + face.box.height * 0.6;
    check(
      rEye.x < lEye.x && inUpperHalf(rEye.y) && inUpperHalf(lEye.y),
      `${image.file} eye landmarks`,
      `rEye ${rEye.x.toFixed(3)},${rEye.y.toFixed(3)} lEye ${lEye.x.toFixed(3)},${lEye.y.toFixed(3)}`,
    );
  }
}

// -------------------------------------------- the same photograph, made smaller

/**
 * What a Crop's caller loses by never sending the photograph at full size.
 *
 * meco bounds a Source Image to `LONG_EDGE` before `/detect` ever sees it, because
 * a Vercel Function refuses a body over 4.5 MB and an ordinary 12 MP photograph
 * is larger than that — issue #30. The bound is only defensible if detection does
 * not depend on the resolution it is handed, and this is where that is measured
 * rather than assumed.
 *
 * `artemis-2-crew-original.jpg` is the untouched 5878x7348 Commons original of
 * the group fixture, so the hand-marked boxes of `artemis-2-crew.jpg` are its
 * boxes too: a box is a fraction of the image and a fraction does not change with
 * resolution. That is also the claim being checked — if any coordinate mapping
 * were needed after a resize, these numbers would move.
 *
 * The caps span both sides of meco's, so this keeps meaning what it means if that
 * number is ever retuned. There is no import of it: the detector is a separate
 * service and must not learn what its caller happens to be configured with.
 */
const ORIGINAL = "artemis-2-crew-original.jpg";
const originalOf = "artemis-2-crew.jpg";
const marked = expected.images.find((i) => i.file === originalOf);

if (!marked) {
  check(false, `${originalOf} is in expected.json`, "the group fixture's marked boxes are missing");
} else {
  const bytes = await readFile(`${FIXTURES}${ORIGINAL}`);
  const atFullSize = await detectFaces(bytes);

  check(
    atFullSize.width === 5878 && atFullSize.height === 7348,
    `${ORIGINAL} is the untouched original`,
    `${String(atFullSize.width)}x${String(atFullSize.height)}, ${String(bytes.length)} bytes`,
  );

  /** Each hand-marked face paired with the detection nearest to it. */
  const claim = (faces: Face[]) => {
    const unclaimed = new Set(faces);
    return marked.faces.map(({ label, box }) => {
      let best: Face | undefined;
      let bestBy = Infinity;
      for (const face of unclaimed) {
        const d = deviation(box, face.box);
        if (d < bestBy) {
          bestBy = d;
          best = face;
        }
      }
      if (best) unclaimed.delete(best);
      return { label, off: bestBy, face: best };
    });
  };

  const truth = claim(atFullSize.faces);
  check(
    atFullSize.faces.length === marked.faces.length &&
      truth.every((f) => f.off <= expected.tolerance),
    `${ORIGINAL} at full size`,
    truth.map((f) => `${f.label} ${f.off.toFixed(4)}`).join(", "),
  );

  for (const longEdge of [2048, 1600, 1280, 640]) {
    const smaller = await sharp(bytes)
      .rotate()
      .resize({ width: longEdge, height: longEdge, fit: "inside" })
      .jpeg({ quality: 90 })
      .toBuffer();
    const found = await detectFaces(smaller);
    const paired = claim(found.faces);

    check(
      found.faces.length === marked.faces.length && paired.every((f) => f.off <= expected.tolerance),
      `${ORIGINAL} at ${String(longEdge)} px finds the same faces`,
      `${(smaller.length / 1e6).toFixed(2)} MB, ` +
        paired.map((f) => `${f.label} ${f.off.toFixed(4)}`).join(", "),
    );

    // Against the full-size answer rather than against the hand-marked boxes:
    // a human's box has a few per cent of slack in it, and this has to catch a
    // shift far smaller than that slack would hide.
    const moved = Math.max(
      ...paired.map((f, i) =>
        f.face && truth[i]?.face ? deviation(f.face.box, truth[i].face.box) : Infinity,
      ),
    );
    check(
      moved <= 0.005,
      `${ORIGINAL} at ${String(longEdge)} px puts them in the same places`,
      `worst coordinate moved ${moved.toFixed(4)} from the full-size detection`,
    );
  }
}

// ------------------------------------------------------- awkward colour input

// A photograph is not always three 8-bit channels on the way in. sharp converts
// to sRGB inside the pipeline, so all of these should come out the same — but
// the tensor is packed by walking the raw buffer with a stride of three, and if
// that assumption ever stopped holding the faces would move rather than the
// call failing.
const portrait = await readFile(`${FIXTURES}astronaut-portrait.jpg`);
const truth = (await detectFaces(portrait)).faces[0]!.box;

for (const [label, encode] of [
  ["greyscale jpeg", () => sharp(portrait).greyscale().jpeg().toBuffer()],
  ["single-channel png", () => sharp(portrait).toColourspace("b-w").png().toBuffer()],
  ["cmyk jpeg", () => sharp(portrait).toColourspace("cmyk").jpeg().toBuffer()],
  ["rgba png", () => sharp(portrait).ensureAlpha().png().toBuffer()],
] as const) {
  const { faces } = await detectFaces(await encode());
  const off = faces.length === 1 ? deviation(truth, faces[0]!.box) : Infinity;
  check(
    off <= expected.tolerance,
    `${label} finds the same face`,
    faces.length === 1
      ? `box off by ${off.toFixed(4)} from the sRGB answer`
      : `expected 1 face, found ${String(faces.length)}`,
  );
}

// ------------------------------------------------------------------- the API

const TOKEN = "detect-test-token";
const app = createFacesApp(TOKEN);
const photo = await readFile(`${FIXTURES}astronaut-portrait.jpg`);

const post = (headers: Record<string, string>, path = "/detect") =>
  app.fetch(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", ...headers },
      body: new Uint8Array(photo),
    }),
  );

const anonymous = await post({});
check(anonymous.status === 401, "POST /detect without a token", `status ${String(anonymous.status)}`);

const wrong = await post({ authorization: "Bearer not-the-token" });
check(wrong.status === 401, "POST /detect with the wrong token", `status ${String(wrong.status)}`);

const bearer = await post({ authorization: `Bearer ${TOKEN}` });
check(bearer.status === 200, "POST /detect with a bearer token", `status ${String(bearer.status)}`);

const direct = await post({ "x-auth-token": TOKEN });
check(direct.status === 200, "POST /detect with x-auth-token", `status ${String(direct.status)}`);

// Vercel's rewrite hands the path through unchanged, so the prefixed forms have
// to behave exactly like the bare ones — token check included.
const prefixed = await post({ authorization: `Bearer ${TOKEN}` }, "/faces/detect");
check(prefixed.status === 200, "POST /faces/detect with a token", `status ${String(prefixed.status)}`);

const prefixedAnonymous = await post({}, "/faces/detect");
check(
  prefixedAnonymous.status === 401,
  "POST /faces/detect without a token",
  `status ${String(prefixedAnonymous.status)}`,
);

const empty = await app.fetch(
  new Request("http://local/detect", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  }),
);
check(empty.status === 400, "POST /detect with no body", `status ${String(empty.status)}`);

const prefixedHealth = await app.fetch(new Request("http://local/faces/health"));
check(prefixedHealth.status === 200, "GET /faces/health", `status ${String(prefixedHealth.status)}`);

const health = await app.fetch(new Request("http://local/health"));
const reported = (await health.json()) as {
  models: { name: string }[];
  onnxruntime: string;
};
check(
  health.status === 200 &&
    reported.models.some((m) => m.name === "yunet") &&
    /^\d+\.\d+\.\d+/.test(reported.onnxruntime),
  "GET /health names the models and the runtime",
  `${reported.models.map((m) => m.name).join(", ")} on ONNX Runtime ${reported.onnxruntime}`,
);

// ------------------------------------------------------------------ the tally

for (const c of checks) {
  console.log(`${c.ok ? "ok    " : "FAIL  "} ${c.label.padEnd(38)} ${c.detail}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${String(checks.length)} checks, ${String(failed.length)} failed`);
if (failed.length > 0) process.exitCode = 1;
