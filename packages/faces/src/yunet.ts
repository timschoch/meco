/**
 * Turning YuNet's twelve raw output tensors into faces.
 *
 * OpenCV ships a decoder for this model, but only inside its own DNN module —
 * taking it would mean a second ML runtime in the image for one model that ONNX
 * Runtime already runs. So the decode lives here instead, ported from
 * `FaceDetectorYNImpl` in OpenCV's `modules/objdetect/src/face_detect.cpp`.
 *
 * Nothing in this file touches sharp or ONNX Runtime: it takes plain typed
 * arrays and returns plain numbers, which is what makes it testable against a
 * fixture without a session or an image decoder in the way.
 */

/** A point in the padded network frame, in pixels. */
export interface Point {
  x: number;
  y: number;
}

/** A face rectangle: top-left corner plus size, in the frame it was decoded in. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The five points YuNet emits, in the order it emits them.
 *
 * The order is not cosmetic. `eye midpoint` drives the headroom rule a Crop
 * uses, and the same five points in this same order are what ArcFace-style
 * alignment consumes later — OpenCV's own `alignCrop` reads them straight
 * through with no reordering.
 */
export interface Landmarks {
  rEye: Point;
  lEye: Point;
  nose: Point;
  rMouth: Point;
  lMouth: Point;
}

export interface DetectedFace {
  box: Box;
  landmarks: Landmarks;
  score: number;
}

/** The three feature-map strides the network emits, smallest faces first. */
export const STRIDES = [8, 16, 32] as const;

export type Stride = (typeof STRIDES)[number];

/**
 * One stride's four tensors, already unwrapped to flat arrays.
 *
 * Shapes at stride `s` over a padded `padH x padW` input, with
 * `n = (padH / s) * (padW / s)` grid cells: `cls` and `obj` are `[n]`, `bbox`
 * is `[n * 4]`, `kps` is `[n * 10]`.
 */
export interface StrideOutputs {
  cls: ArrayLike<number>;
  obj: ArrayLike<number>;
  bbox: ArrayLike<number>;
  kps: ArrayLike<number>;
}

export type YunetOutputs = Record<Stride, StrideOutputs>;

export interface DecodeOptions {
  /** Padded input width the network actually saw. Must be a multiple of 32. */
  padWidth: number;
  /** Padded input height the network actually saw. Must be a multiple of 32. */
  padHeight: number;
  /** Minimum confidence to keep a candidate. OpenCV's own default is 0.9. */
  scoreThreshold: number;
  /** Two boxes overlapping by more than this share are the same face. */
  nmsThreshold: number;
  /** Candidates kept before NMS runs, highest score first. */
  topK: number;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Read every grid cell of every stride and keep the cells that look like a face.
 *
 * The network is anchor-free: one prior per cell, no anchor boxes and no scales,
 * so a cell's index is its position. The tail of the graph is a `Sigmoid`, which
 * is why `cls` and `obj` are used as-is while `bbox` and `kps` are still raw
 * offsets — and why the score is the geometric mean of two probabilities rather
 * than a sum.
 */
function collectCandidates(outputs: YunetOutputs, opts: DecodeOptions): DetectedFace[] {
  const faces: DetectedFace[] = [];

  for (const stride of STRIDES) {
    const { cls, obj, bbox, kps } = outputs[stride];
    const cols = opts.padWidth / stride;
    const rows = opts.padHeight / stride;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const score = Math.sqrt(clamp01(cls[idx] ?? 0) * clamp01(obj[idx] ?? 0));
        if (score < opts.scoreThreshold) continue;

        const b = idx * 4;
        const cx = (c + (bbox[b] ?? 0)) * stride;
        const cy = (r + (bbox[b + 1] ?? 0)) * stride;
        const w = Math.exp(bbox[b + 2] ?? 0) * stride;
        const h = Math.exp(bbox[b + 3] ?? 0) * stride;

        // Landmark offsets are relative to the cell corner, not to the box
        // centre — the one place where the bbox and kps heads disagree.
        const k = idx * 10;
        const point = (n: number): Point => ({
          x: ((kps[k + n * 2] ?? 0) + c) * stride,
          y: ((kps[k + n * 2 + 1] ?? 0) + r) * stride,
        });

        faces.push({
          box: { x: cx - w / 2, y: cy - h / 2, w, h },
          landmarks: {
            rEye: point(0),
            lEye: point(1),
            nose: point(2),
            rMouth: point(3),
            lMouth: point(4),
          },
          score,
        });
      }
    }
  }

  return faces;
}

/** Share of the union two boxes have in common. */
function iou(a: Box, b: Box): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= left || bottom <= top) return 0;
  const overlap = (right - left) * (bottom - top);
  return overlap / (a.w * a.h + b.w * b.h - overlap);
}

/**
 * Greedy non-maximum suppression, highest score first.
 *
 * `topK` truncates *before* the suppression loop, as OpenCV does. On a crowd
 * that changes the answer, not just the cost: a face that would have been
 * suppressed by a truncated neighbour survives.
 */
function suppress(candidates: DetectedFace[], opts: DecodeOptions): DetectedFace[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score).slice(0, opts.topK);
  const kept: DetectedFace[] = [];
  for (const face of sorted) {
    if (kept.every((k) => iou(k.box, face.box) <= opts.nmsThreshold)) kept.push(face);
  }
  return kept;
}

/**
 * Decode one inference into faces, in pixels of the padded network frame.
 *
 * The padding is applied to the bottom and right only, so a detection is
 * already in the un-padded frame and needs no offset back — only the resize
 * factor has to be undone by the caller.
 */
export function decodeYunet(outputs: YunetOutputs, opts: DecodeOptions): DetectedFace[] {
  return suppress(collectCandidates(outputs, opts), opts);
}
