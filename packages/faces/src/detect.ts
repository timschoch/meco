/**
 * Finding faces in a Source Image with YuNet on ONNX Runtime.
 *
 * This is the whole of what meco-faces knows how to do: bytes in, geometry out.
 * It reads nothing, stores nothing and has no idea who anyone is — every face is
 * an anonymous rectangle until meco matches it against a Person.
 *
 * Everything leaves here as a fraction of the image, never as a pixel. A caller
 * that crops, scales or re-encodes the same photo keeps the same numbers, and
 * an Annotation cached under the image's hash stays valid at any resolution.
 */
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-node";
import sharp from "sharp";

import {
  decodeYunet,
  type DetectedFace,
  type Stride,
  type StrideOutputs,
  type YunetOutputs,
} from "./yunet.js";

/**
 * The one model this service loads, copied into the image at build time.
 *
 * The 2026may export, not 2023mar: they are the same weights, but 2023mar has
 * its input height and width baked in as static 640x640 dims and ONNX Runtime
 * refuses any other shape. OpenCV's DNN module hides that by reshaping the graph
 * itself; running the raw ONNX file gives no such help, so the symbolic-dim
 * export is the only one that can take a photo's own aspect ratio.
 */
export const MODEL = {
  name: "yunet",
  file: "face_detection_yunet_2026may.onnx",
  licence: "MIT",
} as const;

const MODEL_PATH = fileURLToPath(new URL(`../models/${MODEL.file}`, import.meta.url));

/** Long side the image is resized to before detection. */
const LONG_SIDE = 640;

/**
 * OpenCV's own header defaults to 0.9, opencv_zoo's demo wrapper to 0.6. 0.6 is
 * the useful one here: a Crop wants the small background faces too, and a
 * spurious box costs far less than a missed Subject.
 */
const SCORE_THRESHOLD = 0.6;
const NMS_THRESHOLD = 0.3;
const TOP_K = 5000;

/** The network's dims must be multiples of this, or it fails inside. */
const DIM_MULTIPLE = 32;

export interface DetectOptions {
  scoreThreshold?: number;
  nmsThreshold?: number;
  topK?: number;
  longSide?: number;
}

/** A face as it leaves the service: every number a fraction of the image. */
export interface Face {
  box: { x: number; y: number; w: number; h: number };
  landmarks: {
    rEye: { x: number; y: number };
    lEye: { x: number; y: number };
    nose: { x: number; y: number };
    rMouth: { x: number; y: number };
    lMouth: { x: number; y: number };
  };
  score: number;
}

export interface DetectResult {
  /** Size of the image as a viewer sees it, after EXIF orientation. */
  width: number;
  height: number;
  faces: Face[];
}

/**
 * One session for the life of the process, created on the first request.
 *
 * Creating it costs far more than running it, so it is memoised as the promise
 * rather than the session: two requests arriving before the first create
 * settles must wait on the same create, not start a second one.
 */
let session: Promise<ort.InferenceSession> | undefined;

export function loadModel(): Promise<ort.InferenceSession> {
  session ??= ort.InferenceSession.create(MODEL_PATH);
  return session;
}

/** Whether the session is already warm, for `/health` to report without forcing a load. */
export const isLoaded = () => session !== undefined;

export const runtimeVersion = () => ort.env.versions.common;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Pack a raw RGB buffer as the tensor YuNet was trained to see.
 *
 * OpenCV builds this blob with `blobFromImage` and no optional arguments, so
 * the defaults are the contract: no scaling, no mean subtraction, and
 * `swapRB=false` — which leaves the Mat in OpenCV's native BGR. sharp hands
 * back RGB, so the two outer channels swap on the way in. Getting this backwards
 * still detects faces, just noticeably fewer of them.
 */
function toTensor(rgb: Buffer, width: number, height: number): ort.Tensor {
  const plane = width * height;
  const data = new Float32Array(plane * 3);
  for (let p = 0, i = 0; p < plane; p++, i += 3) {
    data[p] = rgb[i + 2]!;
    data[plane + p] = rgb[i + 1]!;
    data[plane * 2 + p] = rgb[i]!;
  }
  return new ort.Tensor("float32", data, [1, 3, height, width]);
}

/** Gather the twelve output tensors into the per-stride shape the decoder wants. */
function gather(results: ort.InferenceSession.OnnxValueMapType): YunetOutputs {
  const at = (name: string) => {
    const tensor = results[name];
    if (!tensor) throw new Error(`YuNet output "${name}" is missing from the session results.`);
    return tensor.data as Float32Array;
  };
  const forStride = (s: Stride): StrideOutputs => ({
    cls: at(`cls_${s}`),
    obj: at(`obj_${s}`),
    bbox: at(`bbox_${s}`),
    kps: at(`kps_${s}`),
  });
  return { 8: forStride(8), 16: forStride(16), 32: forStride(32) };
}

/** Turn a detection in resized pixels into fractions of the whole image. */
function toFractions(face: DetectedFace, width: number, height: number): Face {
  const point = (p: { x: number; y: number }) => ({ x: p.x / width, y: p.y / height });
  // A box is clamped to the image, a landmark is not: a rectangle hanging off
  // the edge is not a region anything can crop, but an eye guessed just past the
  // border is still the detector's honest estimate of where it is.
  const left = clamp01(face.box.x / width);
  const top = clamp01(face.box.y / height);
  return {
    box: {
      x: left,
      y: top,
      w: clamp01((face.box.x + face.box.w) / width) - left,
      h: clamp01((face.box.y + face.box.h) / height) - top,
    },
    landmarks: {
      rEye: point(face.landmarks.rEye),
      lEye: point(face.landmarks.lEye),
      nose: point(face.landmarks.nose),
      rMouth: point(face.landmarks.rMouth),
      lMouth: point(face.landmarks.lMouth),
    },
    score: face.score,
  };
}

export async function detectFaces(image: Buffer, options: DetectOptions = {}): Promise<DetectResult> {
  const {
    scoreThreshold = SCORE_THRESHOLD,
    nmsThreshold = NMS_THRESHOLD,
    topK = TOP_K,
    longSide = LONG_SIDE,
  } = options;

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

  // Never upscale: a small photo gains no detail from being stretched, and the
  // extra grid cells are paid for at full price.
  const scale = Math.min(1, longSide / Math.max(width, height));
  const fitWidth = Math.max(1, Math.round(width * scale));
  const fitHeight = Math.max(1, Math.round(height * scale));
  const padWidth = Math.ceil(fitWidth / DIM_MULTIPLE) * DIM_MULTIPLE;
  const padHeight = Math.ceil(fitHeight / DIM_MULTIPLE) * DIM_MULTIPLE;

  // Padding goes on the bottom and right only, which is what lets detections be
  // scaled straight back by the resize factor with no offset to undo.
  const rgb = await sharp(image)
    .rotate()
    .resize({ width: fitWidth, height: fitHeight, fit: "fill" })
    .extend({
      right: padWidth - fitWidth,
      bottom: padHeight - fitHeight,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .removeAlpha()
    .raw()
    .toBuffer();

  const model = await loadModel();
  const results = await model.run({ input: toTensor(rgb, padWidth, padHeight) });

  const faces = decodeYunet(gather(results), {
    padWidth,
    padHeight,
    scoreThreshold,
    nmsThreshold,
    topK,
  })
    // Detections land in the *resized* frame, so the resize is the only thing
    // between them and a fraction of the original.
    .map((face) => toFractions(face, fitWidth, fitHeight))
    .filter((face) => face.box.w > 0 && face.box.h > 0);

  return { width, height, faces };
}
