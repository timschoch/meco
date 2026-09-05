import * as ort from "onnxruntime-node";
import sharp from "sharp";
import type { AdapterRegion, DecodedImage } from "@meco/contracts";
import type { Detector } from "../../detector";
import { ModelSession } from "../../session";
import { adapterFile, readLicence } from "../files";
import {
  clamp01,
  decodeOutputs,
  type Face,
  type Outputs,
  type Point,
  type Stride,
  type StrideOutputs,
} from "./outputs";

const NAME = "yunet";

/**
 * Bumped by hand under contracts' rule: weights, preprocessing, thresholds,
 * runtime major. The weights are pinned by `weights.sha256` beside them.
 */
export const YUNET = { name: NAME, version: "1" } as const;

/**
 * The 2026may export, not 2023mar: the same weights, but 2023mar bakes its
 * input size in as static 640x640 and ONNX Runtime refuses any other shape.
 * Only the symbolic-dim export can take a photograph's own aspect ratio.
 */
const WEIGHTS = "face_detection_yunet_2026may.onnx";

/** Long edge the Decoded Image is resized to before detection. */
const LONG_EDGE = 640;

/** The network's dims must be multiples of this, or it fails inside. */
const DIM_MULTIPLE = 32;

/**
 * opencv_zoo's demo value, not OpenCV's header default of 0.9: a Crop wants
 * the small background faces too, and a spurious box costs less than a missed
 * Subject.
 */
const SCORE_THRESHOLD = 0.6;
const NMS_THRESHOLD = 0.3;
const TOP_K = 5000;

/** Fractions are written to this many decimals. */
const DECIMALS = 6;
const round = (n: number): number => Number(n.toFixed(DECIMALS));

/**
 * The tensor YuNet was trained on. OpenCV builds it with `blobFromImage` and
 * no options, so the defaults are the contract: no scaling, no mean, and
 * `swapRB=false`, which leaves OpenCV's native BGR. The Decoded Image is RGB,
 * so the outer channels swap here. Backwards still finds faces, only fewer.
 */
function toTensor(rgb: Uint8Array, width: number, height: number): ort.Tensor {
  const plane = width * height;
  const data = new Float32Array(plane * 3);
  for (let p = 0, i = 0; p < plane; p++, i += 3) {
    data[p] = rgb[i + 2]!;
    data[plane + p] = rgb[i + 1]!;
    data[plane * 2 + p] = rgb[i]!;
  }
  return new ort.Tensor("float32", data, [1, 3, height, width]);
}

/** Gather the twelve output tensors into the per-stride shape the decode wants. */
function gather(results: ort.InferenceSession.OnnxValueMapType): Outputs {
  const at = (name: string) => {
    const tensor = results[name];
    if (!tensor) throw new Error(`YuNet output "${name}" is missing`);
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

/**
 * A face in pixels of the resized frame, as fractions of the image. Every
 * number is clamped to the image: contracts' Box and Point are fractions, and
 * a rectangle hanging off the edge is not a Region anything can crop.
 */
function toRegion(face: Face, width: number, height: number): AdapterRegion {
  const point = (p: Point) => ({
    x: round(clamp01(p.x / width)),
    y: round(clamp01(p.y / height)),
  });
  const x = round(clamp01(face.box.x / width));
  const y = round(clamp01(face.box.y / height));
  const right = round(clamp01((face.box.x + face.box.width) / width));
  const bottom = round(clamp01((face.box.y + face.box.height) / height));
  return {
    kind: "face",
    label: "face",
    box: { x, y, width: round(right - x), height: round(bottom - y) },
    score: round(clamp01(face.score)),
    model: YUNET,
    landmarks: {
      rEye: point(face.landmarks.rEye),
      lEye: point(face.landmarks.lEye),
      nose: point(face.landmarks.nose),
      rMouth: point(face.landmarks.rMouth),
      lMouth: point(face.landmarks.lMouth),
    },
  };
}

export function createYunet(): Detector {
  const session = new ModelSession(adapterFile(NAME, WEIGHTS));

  return {
    model: YUNET,
    licence: readLicence(NAME),
    licenceId: "MIT",
    kinds: ["face"],
    warm: async () => {
      await session.get();
    },
    isWarm: () => session.isWarm(),

    async run(image: DecodedImage): Promise<AdapterRegion[]> {
      // Never enlarge: a small image gains no detail from being stretched, and
      // the extra grid cells are paid for at full price.
      const scale = Math.min(
        1,
        LONG_EDGE / Math.max(image.width, image.height)
      );
      const fitWidth = Math.max(1, Math.round(image.width * scale));
      const fitHeight = Math.max(1, Math.round(image.height * scale));
      const padWidth = Math.ceil(fitWidth / DIM_MULTIPLE) * DIM_MULTIPLE;
      const padHeight = Math.ceil(fitHeight / DIM_MULTIPLE) * DIM_MULTIPLE;

      // Padding goes bottom-right only, so a detection scales straight back by
      // the resize factor with no offset to undo.
      const { data, info } = await sharp(image.data, {
        raw: { width: image.width, height: image.height, channels: 3 },
      })
        .resize({ width: fitWidth, height: fitHeight, fit: "fill" })
        .extend({
          right: padWidth - fitWidth,
          bottom: padHeight - fitHeight,
          background: { r: 0, g: 0, b: 0 },
        })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (info.channels !== 3) {
        throw new Error(
          `yunet: expected 3 channels after resize, got ${info.channels}`
        );
      }

      const model = await session.get();
      const results = await model.run({
        input: toTensor(data, padWidth, padHeight),
      });

      return decodeOutputs(gather(results), {
        padWidth,
        padHeight,
        scoreThreshold: SCORE_THRESHOLD,
        nmsThreshold: NMS_THRESHOLD,
        topK: TOP_K,
      })
        .map((face) => toRegion(face, fitWidth, fitHeight))
        .filter((region) => region.box.width > 0 && region.box.height > 0);
    },
  };
}
