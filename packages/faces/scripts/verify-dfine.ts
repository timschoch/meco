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
const REVISION = "416dc80213e8f2745fcacdfab62980e3c0555306";
const REPO = "AnnotateIt/dfine-nano-coco-onnx";
const AT = `https://huggingface.co/${REPO}/resolve/${REVISION}`;
const SOURCE = `${AT}/model.onnx`;
const CONFIG = `${AT}/config.json`;
const PREPROCESSOR = `${AT}/preprocessor_config.json`;

/** What `models/LICENCE-dfine.txt` claims about the file. Both are the claim. */
const BYTES = 15_434_935;
const SHA256 = "b0ec2e5793f3a3cbd07440d098645a0e102cd450fb92f4f35e713f36e35d152e";

/**
 * The checkpoint the export converts, and the revision it pins.
 *
 * The revision is the point. `066438d3` is the 20 Aug 2025 commit titled "Fix
 * weights"; an export dated before it converts weights that were wrong, which is
 * what the export the research first measured turned out to be doing.
 */
const BASE = "ustc-community/dfine-nano-coco";
const BASE_REVISION = "066438d3d8f0da137a37b38fdf3368fd4afceced";

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

const artefactCard = await fetch(`${AT}/README.md`).then((r) => r.text());
check(
  /^license:\s*apache-2\.0$/m.test(artefactCard),
  "the artefact declares Apache-2.0 on its own card",
  artefactCard.split("---")[1]?.trim().split("\n")[0] ?? "no front-matter",
);

// Section 4 is the reason this one is a check and not a footnote: a repository
// that ships no licence text cannot discharge the attribution obligation on our
// behalf, which is the whole argument for preferring this export.
const licence = await fetch(`${AT}/LICENSE`).then((r) => r.text());
check(
  licence.includes("Apache License") && licence.includes("Version 2.0, January 2004"),
  "and ships the verbatim licence text, which is what section 4 needs",
  `${String(licence.length)} bytes`,
);

const baseCard = await fetch(
  `https://huggingface.co/${BASE}/raw/main/README.md`,
).then((r) => r.text());
check(
  /^license:\s*apache-2\.0$/m.test(baseCard),
  "the weights it converts still declare Apache-2.0",
  baseCard.split("---")[1]?.trim().split("\n").join(" · ") ?? "no front-matter",
);

/**
 * The export still pins the fixed revision of those weights.
 *
 * Not a formality. The export the research first measured is dated four months
 * before `Fix weights` landed, and converting the earlier commit cost 8 of 29
 * usable kart boxes across the research set — a difference no licence check and
 * no graph check would have noticed.
 */
const report = (await fetch(`${AT}/validation-report.json`).then((r) => r.json())) as {
  source: { modelId: string; revision: string };
  artifact: { bytes: number; sha256: string };
};
check(
  report.source.modelId === BASE && report.source.revision === BASE_REVISION,
  "and the export still pins the fixed revision of them",
  `${report.source.modelId}@${report.source.revision.slice(0, 12)}`,
);
check(
  report.artifact.bytes === BYTES && report.artifact.sha256 === SHA256,
  "the export's own report describes the file we committed",
  `${String(report.artifact.bytes)} B, ${report.artifact.sha256.slice(0, 16)}…`,
);

const commits = (await fetch(
  `https://huggingface.co/api/models/${BASE}/commits/main`,
).then((r) => r.json())) as { id: string; title: string }[];
check(
  commits[0]?.id === BASE_REVISION,
  "and no newer commit has landed on the weights since",
  commits[0] ? `head is ${commits[0].id.slice(0, 12)} "${commits[0].title}"` : "no history",
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
