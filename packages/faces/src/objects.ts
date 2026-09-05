/**
 * Finding objects in a Source Image with D-FINE-N on ONNX Runtime.
 *
 * The second thing meco-faces knows how to do, and the same contract as the
 * first: bytes in, geometry out, nothing stored and nobody identified. What it
 * exists for is a karting photograph — `docs/research/kart-and-driver-subjects.md`
 * measures YuNet putting a box on the leading driver's head in 9 of 32 on-track
 * photographs, because a helmet is not a face. A COCO-pretrained detector finds
 * the kart on 21 of 32 and the driver on 20, and the two miss different
 * photographs.
 *
 * Deliberately *not* a `/kart` endpoint. This service returns what it saw, in
 * the vocabulary the model was trained in; deciding that a `motorbike` and the
 * `person` on top of it are one Subject is framing policy, and framing policy
 * lives in meco beside every other producer where it can be tested as
 * arithmetic. That is also what ADR-0002's "a service that only ever sees bytes
 * and returns geometry can be swapped for a different detector" means in
 * practice — a different detector would return different labels, not a different
 * idea of what a kart is.
 */
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-node";
import sharp from "sharp";

import { decodeDfine, type DetectedObject } from "./dfine.js";

/**
 * The one object model this service loads, copied into the image at build time.
 *
 * fp32 and not the q4f16 build that is a third of the size, because the smaller
 * one measured **2.3x slower and less accurate**: 64 ms warm against 28 ms, and
 * four fewer karts and two fewer drivers found across the 32-photograph set. The
 * same trap the research recorded for MoveNet, where int8 measured 31.83 ms
 * against fp32's 14.41 ms. Quantisation is not a free size saving on this
 * runtime and should not be reached for without measuring again.
 *
 * The licence is the one part of this that is not a plain fact off a model card.
 * `onnx-community/dfine_n_coco-ONNX` declares none; the chain to Apache-2.0 runs
 * through its `base_model` pointer. `models/LICENCE-dfine.txt` records the whole
 * of it, including how to re-verify.
 */
export const OBJECT_MODEL = {
  name: "dfine-n-coco",
  file: "dfine_n_coco.onnx",
  licence: "Apache-2.0",
} as const;

const MODEL_PATH = fileURLToPath(new URL(`../models/${OBJECT_MODEL.file}`, import.meta.url));

/**
 * The square the network is trained to see, from `preprocessor_config.json`.
 *
 * Both dimensions are baked into the exported graph, so this is a fact about the
 * model rather than a tuning knob. The image is *stretched* into it rather than
 * letterboxed — `do_pad: false` — which is why the decoded boxes need no aspect
 * correction on the way back: a fraction of a stretched square is the same
 * fraction of the original.
 */
const INPUT_SIDE = 640;

/**
 * How confident the network has to be. Q11 measured the set at this threshold.
 *
 * Low by the standards of a detector meant to be right, and deliberately: a
 * kart is small, low, half-occluded by its own driver and nothing like the
 * motorbikes COCO was labelled with, so the scores it earns are 0.28-0.48 rather
 * than the 0.9 a photograph of a dog gets. Every number in the research was
 * measured here, so moving it invalidates them.
 */
const SCORE_THRESHOLD = 0.28;

/** Two boxes of one class overlapping by more than this share are one object. */
const NMS_THRESHOLD = 0.6;

/**
 * How many objects one answer may carry.
 *
 * There is a real crowd case behind this: the research's worst photograph
 * returns 23 spectators. They are all honest detections and meco files them in
 * an Annotation, but an answer is not a place to put an unbounded list, and
 * nothing downstream reads past the largest few.
 */
const TOP_K = 50;

/** A model that would not load. Not the caller's fault, and not a 400. */
export class ObjectModelLoadError extends Error {}

export interface ObjectsResult {
  /** Size of the image as a viewer sees it, after EXIF orientation. */
  width: number;
  height: number;
  objects: DetectedObject[];
}

/**
 * One session for the life of the process, memoised exactly as `detect.ts` does.
 *
 * Creating it measured 167 ms against 28 ms to run it, so two requests arriving
 * before the first create settles must wait on the same create rather than
 * starting a second. A create that fails drops the memo, so a bad boot does not
 * poison the container for its whole life.
 */
let session: Promise<ort.InferenceSession> | undefined;

export function loadObjectModel(): Promise<ort.InferenceSession> {
  session ??= ort.InferenceSession.create(MODEL_PATH).catch((err: unknown) => {
    session = undefined;
    throw new ObjectModelLoadError(`Could not load ${OBJECT_MODEL.file}: ${String(err)}`);
  });
  return session;
}

/** Whether the session is already warm, for `/health` to report without forcing a load. */
export const isObjectModelLoaded = () => session !== undefined;

/**
 * Pack a raw RGB buffer as the tensor D-FINE was trained to see.
 *
 * Three things here are the opposite of what every other model in this repo
 * wants, and all three come from `preprocessor_config.json`:
 *
 * - **RGB, not BGR.** YuNet is an OpenCV export and wants its channels swapped;
 *   this is a Hugging Face export and does not.
 * - **Rescaled to 0..1** — `do_rescale: true`, factor 1/255. YuNet takes raw
 *   0..255.
 * - **Not normalised.** `do_normalize: false`, so the ImageNet mean and std that
 *   the same config file also lists are *not* applied. They are there because
 *   the processor class carries defaults, not because this model uses them.
 *   Subtracting them anyway still detects objects, just fewer and in slightly
 *   wrong places, which is precisely the failure a test on a photograph does not
 *   notice.
 */
function toTensor(rgb: Buffer): ort.Tensor {
  const plane = INPUT_SIDE * INPUT_SIDE;
  const data = new Float32Array(plane * 3);
  for (let p = 0, i = 0; p < plane; p++, i += 3) {
    data[p] = rgb[i]! / 255;
    data[plane + p] = rgb[i + 1]! / 255;
    data[plane * 2 + p] = rgb[i + 2]! / 255;
  }
  return new ort.Tensor("float32", data, [1, 3, INPUT_SIDE, INPUT_SIDE]);
}

export async function detectObjects(image: Buffer): Promise<ObjectsResult> {
  const meta = await sharp(image).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Could not read the image dimensions — is this really an image?");
  }
  // Orientation 5..8 are the quarter-turn EXIF cases, where the stored pixels
  // are transposed relative to what anyone actually sees. `.rotate()` below
  // straightens them, so the reported size has to be the straightened one too.
  const turned = (meta.orientation ?? 1) >= 5;
  const width = turned ? meta.height : meta.width;
  const height = turned ? meta.width : meta.height;

  // `fill` — the image is stretched into the square, not letterboxed into it.
  // That is what the model was trained and exported with, and it is also what
  // makes a decoded fraction of the square a fraction of the photograph with no
  // padding offset to undo. Getting this wrong by using `contain` would put
  // every box in the wrong place by however much of the square was bars.
  const { data: rgb, info } = await sharp(image)
    .rotate()
    .resize({ width: INPUT_SIDE, height: INPUT_SIDE, fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // sharp converts to sRGB on the way through, so a greyscale or CMYK
  // photograph arrives as three channels like everything else. `toTensor` walks
  // the buffer with a stride of three, and reading it with the wrong stride
  // would not throw — it would return objects in the wrong places.
  if (info.channels !== 3) {
    throw new Error(`Expected three channels after decoding, got ${String(info.channels)}.`);
  }

  const model = await loadObjectModel();
  const results = await model.run({ pixel_values: toTensor(rgb) });

  const logits = results.logits?.data;
  const boxes = results.pred_boxes?.data;
  if (!(logits instanceof Float32Array) || !(boxes instanceof Float32Array)) {
    throw new ObjectModelLoadError(
      `${OBJECT_MODEL.file} did not answer with logits and pred_boxes — is this the right export?`,
    );
  }

  const objects = decodeDfine(
    { logits, boxes },
    { scoreThreshold: SCORE_THRESHOLD, nmsThreshold: NMS_THRESHOLD, topK: TOP_K },
  );

  return { width, height, objects };
}
