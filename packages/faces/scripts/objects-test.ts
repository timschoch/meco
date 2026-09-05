/**
 * Prove the D-FINE decode is arithmetic and not a coincidence.
 *
 * This is the test the ticket was explicit about needing. The Hugging Face
 * export stops at raw logits and normalised `cxcywh` boxes, so roughly forty
 * lines of decode stand between the graph and an answer — and every ordinary
 * mistake in those forty lines still produces plausible rectangles on a
 * photograph of a kart. A missing sigmoid keeps the ranking and moves the
 * threshold. A centre read as a corner shifts every box by half its own size,
 * which on a subject filling a third of the frame still looks like a detection.
 * Class-agnostic suppression deletes the driver and leaves the kart. None of
 * those would fail a test that only asks "did it find something".
 *
 * So the first half of this file hands `decodeDfine` tensors written by hand,
 * with answers worked out on paper. The second half runs the real model over the
 * six committed karting photographs and holds it to boxes that were rendered
 * over the photographs and looked at. The third drives the HTTP surface.
 *
 * Same shape as `detect-test.ts`: one line per check, non-zero exit on failure.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createFacesApp } from "../src/app.js";
import {
  CLASS_COUNT,
  COCO_LABELS,
  decodeDfine,
  type Box,
  type DetectedObject,
} from "../src/dfine.js";
import { detectObjects } from "../src/objects.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/karts/", import.meta.url));

interface Expectation {
  file: string;
  width: number;
  height: number;
  note: string;
  objects: { label: string; score: number; box: Box }[];
  subject: Box;
  subjectNote: string;
}

const expected = JSON.parse(await readFile(`${FIXTURES}objects.json`, "utf8")) as {
  tolerance: number;
  images: Expectation[];
};

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

// --------------------------------------------------- the decode, on paper

const PERSON = 0;
const MOTORBIKE = 3;

/**
 * The logit that means "this class is not here".
 *
 * Not zero, and that matters: `sigmoid(0)` is 0.5, which clears every threshold
 * worth using. A background written as zeros would make all 300 queries fire on
 * class 0 and the fixtures below would still pass, because they only look at the
 * strongest few.
 */
const ABSENT = -20;

/** The logit whose sigmoid is exactly `p`. */
const logitOf = (p: number) => Math.log(p / (1 - p));

interface Query {
  classId: number;
  /** The probability this query should end up reporting. */
  score: number;
  /** Centre-x, centre-y, width, height — the form the graph emits. */
  cxcywh: [number, number, number, number];
}

/** Two flat tensors shaped as the graph emits them, from queries written out. */
function tensorsFor(queries: Query[]): { logits: Float32Array; boxes: Float32Array } {
  const logits = new Float32Array(queries.length * CLASS_COUNT).fill(ABSENT);
  const boxes = new Float32Array(queries.length * 4);
  queries.forEach((q, i) => {
    logits[i * CLASS_COUNT + q.classId] = logitOf(q.score);
    boxes.set(q.cxcywh, i * 4);
  });
  return { logits, boxes };
}

const decode = (queries: Query[], nms = 0.6, threshold = 0.28, topK = 50) =>
  decodeDfine(tensorsFor(queries), {
    queries: queries.length,
    scoreThreshold: threshold,
    nmsThreshold: nms,
    topK,
  });

const near = (a: number, b: number, slack = 1e-6) => Math.abs(a - b) <= slack;

// A centre at (0.5, 0.5) sized 0.4 x 0.6 is the rectangle from (0.3, 0.2) to
// (0.7, 0.8). Worked out by hand, which is the whole point of this one: it is
// the check that fails if a centre is ever read as a corner.
{
  const [only] = decode([{ classId: MOTORBIKE, score: 0.9, cxcywh: [0.5, 0.5, 0.4, 0.6] }]);
  check(
    only !== undefined &&
      near(only.box.x, 0.3) &&
      near(only.box.y, 0.2) &&
      near(only.box.width, 0.4) &&
      near(only.box.height, 0.6),
    "cxcywh becomes a top-left corner and a size",
    only ? `x${only.box.x} y${only.box.y} w${only.box.width} h${only.box.height}` : "no object",
  );
  check(
    only !== undefined && only.label === "motorbike" && only.classId === MOTORBIKE,
    "class 3 is motorbike, which is the class that finds a kart",
    only?.label ?? "no object",
  );
  check(
    only !== undefined && near(only.score, 0.9, 1e-6),
    "a raw logit becomes a probability through the sigmoid",
    only ? only.score.toFixed(6) : "no object",
  );
}

// The threshold is compared against the sigmoid, not against the logit. A raw
// logit of -1 is *above* a threshold of 0.28 as a number and far below it as a
// probability — sigmoid(-1) is 0.269. Exactly the pair that catches a decode
// which forgot to squash.
{
  const kept = decode([
    { classId: PERSON, score: 0.269, cxcywh: [0.5, 0.5, 0.2, 0.2] },
    { classId: PERSON, score: 0.281, cxcywh: [0.1, 0.1, 0.05, 0.05] },
  ]);
  check(
    kept.length === 1 && near(kept[0]!.score, 0.281, 1e-6),
    "the threshold cuts on the probability, not on the logit",
    kept.map((k) => k.score.toFixed(3)).join(", ") || "nothing kept",
  );
}

// One query commits to one object, so its best class wins outright and its
// second-best is not a second detection.
{
  const logits = new Float32Array(CLASS_COUNT).fill(ABSENT);
  logits[PERSON] = logitOf(0.6);
  logits[MOTORBIKE] = logitOf(0.8);
  const found = decodeDfine(
    { logits, boxes: new Float32Array([0.5, 0.5, 0.2, 0.2]) },
    { queries: 1, classes: CLASS_COUNT, scoreThreshold: 0.28, nmsThreshold: 0.6, topK: 50 },
  );
  check(
    found.length === 1 && found[0]!.classId === MOTORBIKE,
    "a query reports its best class and only its best class",
    found.map((f) => `${f.label} ${f.score.toFixed(2)}`).join(", "),
  );
}

/**
 * Suppression is per class, and this is the check that says so.
 *
 * A driver sits inside their kart. These two boxes are identical, so their IoU
 * is 1 and any threshold suppresses them — if the suppression is allowed to
 * compare across classes. It must not be: the union rule meco composes needs the
 * `motorbike` and the `person` both to survive, and losing one of them would
 * look like a detector that simply did not see the driver.
 */
{
  const same: [number, number, number, number] = [0.5, 0.5, 0.4, 0.4];
  const both = decode([
    { classId: MOTORBIKE, score: 0.42, cxcywh: same },
    { classId: PERSON, score: 0.39, cxcywh: same },
  ]);
  check(
    both.length === 2 && new Set(both.map((o) => o.label)).size === 2,
    "a person inside a motorbike survives suppression",
    both.map((o) => `${o.label} ${o.score.toFixed(2)}`).join(", ") || "nothing kept",
  );

  const twice = decode([
    { classId: MOTORBIKE, score: 0.42, cxcywh: same },
    { classId: MOTORBIKE, score: 0.39, cxcywh: same },
  ]);
  check(
    twice.length === 1 && near(twice[0]!.score, 0.42, 1e-6),
    "two motorbikes on one kart collapse to the stronger",
    twice.map((o) => o.score.toFixed(2)).join(", ") || "nothing kept",
  );
}

// The 300 queries are a fixed count, not a top-k, so a real inference answers
// something on nearly all of them. Nothing here may quietly read past the end.
{
  const many = Array.from({ length: 12 }, (_, i): Query => ({
    classId: PERSON,
    score: 0.9 - i * 0.01,
    // Spread far enough apart that suppression has nothing to do — this is
    // about the cut, not about the overlap.
    cxcywh: [0.04 + i * 0.08, 0.5, 0.02, 0.02],
  }));
  const capped = decode(many, 0.6, 0.28, 5);
  check(
    capped.length === 5 && near(capped[0]!.score, 0.9, 1e-6),
    "topK keeps the strongest and stops",
    `${String(capped.length)} kept, strongest ${capped[0]?.score.toFixed(2) ?? "-"}`,
  );
}

// The network puts centres and edges slightly outside the image — measured,
// `pred_boxes` reaches -0.059 and 1.054. A box has to be clamped to something
// croppable, and a box entirely outside is not a detection at all.
{
  const [hanging] = decode([{ classId: PERSON, score: 0.5, cxcywh: [0.05, 0.5, 0.4, 0.2] }]);
  check(
    hanging !== undefined && near(hanging.box.x, 0) && near(hanging.box.width, 0.25),
    "a box hanging off the left edge is clamped, not shifted",
    hanging ? `x${hanging.box.x} w${hanging.box.width}` : "no object",
  );

  const gone = decode([{ classId: PERSON, score: 0.5, cxcywh: [-0.5, 0.5, 0.2, 0.2] }]);
  check(gone.length === 0, "a box entirely outside the image is dropped", `${String(gone.length)} kept`);
}

check(
  COCO_LABELS.length === 80 && COCO_LABELS[0] === "person" && COCO_LABELS[3] === "motorbike",
  "the label list is the model's own id2label",
  `${String(COCO_LABELS.length)} labels, 0=${COCO_LABELS[0]}, 3=${COCO_LABELS[3]}`,
);

// ------------------------------------------------------------- the fixtures

for (const image of expected.images) {
  const bytes = await readFile(`${FIXTURES}${image.file}`);
  const started = Date.now();
  const result = await detectObjects(bytes);
  const ms = Date.now() - started;

  check(
    result.width === image.width && result.height === image.height,
    `${image.file} is measured at its own size`,
    `${String(result.width)}x${String(result.height)}, ${String(ms)} ms`,
  );

  // The class *set* is the claim a human verified by looking at the rendered
  // boxes; the exact scores are not, and are recorded rather than asserted.
  const labels = (objects: { label: string }[]) =>
    objects
      .map((o) => o.label)
      .sort()
      .join(" ");
  check(
    labels(result.objects) === labels(image.objects),
    `${image.file} finds the same classes`,
    `${labels(result.objects)} — ${image.note}`,
  );

  // Each recorded box claims the detection nearest to it, and a detection may
  // only be claimed once: two expectations collapsing onto one box is exactly
  // the duplicate-suppression bug that would otherwise pass.
  const unclaimed = new Set<DetectedObject>(result.objects);
  for (const want of image.objects) {
    let best: DetectedObject | undefined;
    let bestBy = Infinity;
    for (const object of unclaimed) {
      if (object.label !== want.label) continue;
      const d = deviation(want.box, object.box);
      if (d < bestBy) {
        bestBy = d;
        best = object;
      }
    }
    if (best) unclaimed.delete(best);
    check(
      bestBy <= expected.tolerance,
      `${image.file} ${want.label} ${want.score.toFixed(2)}`,
      `worst coordinate off by ${bestBy.toFixed(4)} (allowed ${expected.tolerance.toFixed(2)})`,
    );
  }
}

// ------------------------------------------------------------------ the API

const TOKEN = "objects-test-token";
const app = createFacesApp(TOKEN);
const photo = await readFile(`${FIXTURES}on-track-rear-helmet.jpg`);

const post = (headers: Record<string, string>, path = "/objects") =>
  app.fetch(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", ...headers },
      body: new Uint8Array(photo),
    }),
  );

const anonymous = await post({});
check(anonymous.status === 401, "POST /objects without a token", `status ${String(anonymous.status)}`);

const wrong = await post({ authorization: "Bearer not-the-token" });
check(wrong.status === 401, "POST /objects with the wrong token", `status ${String(wrong.status)}`);

const bearer = await post({ authorization: `Bearer ${TOKEN}` });
check(bearer.status === 200, "POST /objects with a bearer token", `status ${String(bearer.status)}`);

const direct = await post({ "x-auth-token": TOKEN });
check(direct.status === 200, "POST /objects with x-auth-token", `status ${String(direct.status)}`);

// Vercel's rewrite hands the path through unchanged, so the prefixed form has to
// behave exactly like the bare one — token check included.
const prefixed = await post({ authorization: `Bearer ${TOKEN}` }, "/faces/objects");
check(prefixed.status === 200, "POST /faces/objects with a token", `status ${String(prefixed.status)}`);

const prefixedAnonymous = await post({}, "/faces/objects");
check(
  prefixedAnonymous.status === 401,
  "POST /faces/objects without a token",
  `status ${String(prefixedAnonymous.status)}`,
);

const empty = await app.fetch(
  new Request("http://local/objects", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  }),
);
check(empty.status === 400, "POST /objects with no body", `status ${String(empty.status)}`);

const notAnImage = await app.fetch(
  new Request("http://local/objects", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: new Uint8Array(Buffer.from("this is not a photograph")),
  }),
);
check(
  notAnImage.status === 400,
  "POST /objects with something that is not an image",
  `status ${String(notAnImage.status)}`,
);

const shape = (await bearer.json()) as {
  width: number;
  height: number;
  objects: Record<string, unknown>[];
};
check(
  shape.objects.length > 0 &&
    shape.objects.every((o) => "label" in o && "score" in o && "box" in o) &&
    // The class index is deliberately not on the wire: it is this model's own
    // numbering, and a caller that read it would be pinned to that ordering.
    shape.objects.every((o) => !("classId" in o)),
  "the answer names a label, a score and a box, and no class index",
  `${String(shape.objects.length)} objects, keys ${Object.keys(shape.objects[0] ?? {}).join(",")}`,
);

// The model has to be listed whether or not anything has loaded it yet: a
// deployment that shipped without the weights answers /health identically
// otherwise, and nobody would find out until a Crop quietly lost its rung.
const health = await app.fetch(new Request("http://local/health"));
const reported = (await health.json()) as {
  models: { name: string; file: string; licence: string; warm: boolean }[];
};
const dfine = reported.models.find((m) => m.name === "dfine-n-coco");
check(
  health.status === 200 && dfine !== undefined && dfine.licence === "Apache-2.0",
  "GET /health names the object model and its licence",
  reported.models.map((m) => `${m.name}${m.warm ? " (warm)" : ""}`).join(", "),
);

// ------------------------------------------------------------------ the tally

for (const c of checks) {
  console.log(`${c.ok ? "ok    " : "FAIL  "} ${c.label.padEnd(52)} ${c.detail}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${String(checks.length)} checks, ${String(failed.length)} failed`);
if (failed.length > 0) process.exitCode = 1;
