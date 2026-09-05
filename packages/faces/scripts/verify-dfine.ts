/**
 * Re-verify the committed D-FINE weights against their source.
 *
 * `export-edgeface.py` exists because EdgeFace ships no ONNX and one has to be
 * produced; it pins an upstream commit and checks the export against the source
 * model. D-FINE needs no export — Hugging Face publishes the artefact — so the
 * equivalent obligation is the other half of that script: prove the file in this
 * repository is the file the licence chain describes, and prove the graph is
 * still the shape the decode was written for.
 *
 * That obligation is unusually real here. `onnx-community/dfine_n_coco-ONNX`
 * declares **no licence of its own** (`models/LICENCE-dfine.txt` records the
 * whole chain and how it resolves to Apache-2.0), and a Hugging Face repository
 * is community-editable. The byte count and the digest are what tie the local
 * file to the evidence in that record; without them the provenance is a story
 * about a URL.
 *
 * Not part of `pnpm test:objects` and not in the gate: it reaches the network,
 * and a test that fails because a laptop is on a train is a test people learn to
 * ignore. Run it when the weights change, when the licence record is questioned,
 * or before a release that ships them.
 *
 *     pnpm --filter meco-faces exec tsx scripts/verify-dfine.ts
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-node";

import { CLASS_COUNT, COCO_LABELS, QUERY_COUNT } from "../src/dfine.js";
import { OBJECT_MODEL } from "../src/objects.js";

/** The repository revision the committed weights were taken from. */
const REVISION = "380d2839c327efaf65dd0fe0c2c10ab7fadd5473";
const REPO = "onnx-community/dfine_n_coco-ONNX";
const SOURCE = `https://huggingface.co/${REPO}/resolve/${REVISION}/onnx/model.onnx`;
const CONFIG = `https://huggingface.co/${REPO}/resolve/${REVISION}/config.json`;
const PREPROCESSOR = `https://huggingface.co/${REPO}/resolve/${REVISION}/preprocessor_config.json`;

/** What `models/LICENCE-dfine.txt` claims about the file. Both are the claim. */
const BYTES = 15_258_358;
const SHA256 = "0f684f409618ee8a822410e754a29caa817d1aa16283ce89cad936d0a48e2f35";

/** The base model whose card carries the licence the chain resolves to. */
const BASE = "https://huggingface.co/ustc-community/dfine_n_coco";

const checks: { ok: boolean; label: string; detail: string }[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  checks.push({ ok, label, detail });
};

const modelPath = fileURLToPath(new URL(`../models/${OBJECT_MODEL.file}`, import.meta.url));
const local = await readFile(modelPath);
const digest = createHash("sha256").update(local).digest("hex");

check(local.length === BYTES, "the committed file is the recorded size", `${String(local.length)} B`);
check(digest === SHA256, "and the recorded digest", digest);

// --------------------------------------------------------------- the source

const head = await fetch(SOURCE, { method: "HEAD", redirect: "follow" });
// Hugging Face serves the bytes from a CDN, so `content-length` describes the
// redirect and `x-linked-size` describes the file. Reading the wrong one gives a
// three-digit number that looks nothing like a model and everything like a bug.
const upstream = Number(head.headers.get("x-linked-size") ?? head.headers.get("content-length"));
check(
  upstream === local.length,
  "upstream still serves that many bytes at the pinned revision",
  `${String(upstream)} B at ${REVISION.slice(0, 12)}`,
);

// --------------------------------------------------------- the licence chain

const redirect = await fetch(BASE, { method: "HEAD", redirect: "manual" });
const location = redirect.headers.get("location") ?? "";
check(
  redirect.status === 307 && location.includes("dfine-nano-coco"),
  "the base_model pointer still resolves rather than 404ing",
  `${String(redirect.status)} → ${location || "(nowhere)"}`,
);

const baseCard = await fetch(
  "https://huggingface.co/ustc-community/dfine-nano-coco/raw/main/README.md",
).then((r) => r.text());
check(
  /^license:\s*apache-2\.0$/m.test(baseCard),
  "and the base model still declares Apache-2.0",
  baseCard.split("---")[1]?.trim().split("\n").join(" · ") ?? "no front-matter",
);

const artefactCard = await fetch(
  `https://huggingface.co/${REPO}/raw/${REVISION}/README.md`,
).then((r) => r.text());
// The absence is the finding, not a failure. If this ever starts declaring a
// licence, `models/LICENCE-dfine.txt` can be shortened — so it is worth knowing.
check(
  true,
  "the artefact's own card declares",
  /^license:/m.test(artefactCard)
    ? "a licence — LICENCE-dfine.txt can now be shortened"
    : "no licence, which is why LICENCE-dfine.txt exists",
);

// ------------------------------------------------------------ the graph

const preprocessor = (await fetch(PREPROCESSOR).then((r) => r.json())) as {
  do_normalize: boolean;
  do_rescale: boolean;
  do_pad: boolean;
  size: { height: number; width: number };
};
check(
  preprocessor.do_normalize === false &&
    preprocessor.do_rescale === true &&
    preprocessor.do_pad === false &&
    preprocessor.size.height === 640 &&
    preprocessor.size.width === 640,
  "preprocessing is still rescale-only into a 640 square, with no normalisation",
  `normalize=${String(preprocessor.do_normalize)} rescale=${String(preprocessor.do_rescale)} ` +
    `pad=${String(preprocessor.do_pad)} size=${String(preprocessor.size.width)}x${String(preprocessor.size.height)}`,
);

const config = (await fetch(CONFIG).then((r) => r.json())) as { id2label: Record<string, string> };
const labels = Object.keys(config.id2label)
  .map(Number)
  .sort((a, b) => a - b)
  .map((i) => config.id2label[String(i)]);
check(
  labels.length === COCO_LABELS.length && labels.every((l, i) => l === COCO_LABELS[i]),
  "COCO_LABELS is still the model's own id2label, in its order",
  `${String(labels.length)} labels; first mismatch ${
    labels.findIndex((l, i) => l !== COCO_LABELS[i])
  }`,
);

const session = await ort.InferenceSession.create(modelPath);
check(
  session.inputNames.length === 1 && session.inputNames[0] === "pixel_values",
  "one input named pixel_values, and no orig_target_sizes",
  session.inputNames.join(", "),
);
check(
  session.outputNames.length === 2 &&
    session.outputNames.includes("logits") &&
    session.outputNames.includes("pred_boxes"),
  "two outputs, logits and pred_boxes",
  session.outputNames.join(", "),
);

const run = await session.run({
  pixel_values: new ort.Tensor("float32", new Float32Array(3 * 640 * 640), [1, 3, 640, 640]),
});
const logits = run.logits!;
const boxes = run.pred_boxes!;
check(
  logits.dims.join("x") === `1x${String(QUERY_COUNT)}x${String(CLASS_COUNT)}` &&
    boxes.dims.join("x") === `1x${String(QUERY_COUNT)}x4`,
  "the shapes the decode indexes into",
  `logits ${logits.dims.join("x")}, pred_boxes ${boxes.dims.join("x")}`,
);

// Raw logits, not probabilities. On a blank image every score should be firmly
// negative — if this ever comes back inside 0..1 the graph has grown a sigmoid
// and `decodeDfine` would be squashing an already-squashed number.
const scores = logits.data as Float32Array;
check(
  Math.max(...scores) < 0,
  "the scores are still raw logits rather than probabilities",
  `max ${Math.max(...scores).toFixed(3)} over ${String(scores.length)} values`,
);

for (const c of checks) {
  console.log(`${c.ok ? "ok    " : "FAIL  "} ${c.label.padEnd(64)} ${c.detail}`);
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${String(checks.length)} checks, ${String(failed.length)} failed`);
if (failed.length > 0) process.exitCode = 1;
