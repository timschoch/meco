/**
 * Turning YuNet's twelve raw output tensors into faces.
 *
 * OpenCV ships a decoder for this model, but only inside its own DNN module;
 * taking it would mean a second ML runtime in the image for one model that
 * ONNX Runtime already runs. So the decode lives here, ported from
 * `FaceDetectorYNImpl` in OpenCV's `modules/objdetect/src/face_detect.cpp`.
 *
 * Nothing here touches sharp or ONNX Runtime: typed arrays in, plain numbers
 * out, in pixels of the padded network frame.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The five points YuNet emits, in the order it emits them: right eye, left
 * eye, nose, right mouth corner, left mouth corner, from the subject's side.
 * It is ArcFace's order too, which is what the face Enricher aligns on.
 */
export interface Landmarks {
  rEye: Point;
  lEye: Point;
  nose: Point;
  rMouth: Point;
  lMouth: Point;
}

export interface Face {
  box: Box;
  landmarks: Landmarks;
  score: number;
}

/** The three feature-map strides the network emits, smallest faces first. */
export const STRIDES = [8, 16, 32] as const;

export type Stride = (typeof STRIDES)[number];

/**
 * One stride's four tensors as flat arrays. Over a padded `padHeight x
 * padWidth` input at stride `s`, with `n = (padHeight / s) * (padWidth / s)`
 * grid cells: `cls` and `obj` are `[n]`, `bbox` is `[n * 4]`, `kps` is
 * `[n * 10]`.
 */
export interface StrideOutputs {
  cls: ArrayLike<number>;
  obj: ArrayLike<number>;
  bbox: ArrayLike<number>;
  kps: ArrayLike<number>;
}

export type Outputs = Record<Stride, StrideOutputs>;

export interface DecodeOptions {
  /** Padded input width the network saw. A multiple of 32. */
  padWidth: number;
  /** Padded input height the network saw. A multiple of 32. */
  padHeight: number;
  /** Minimum confidence to keep a candidate. */
  scoreThreshold: number;
  /** Two boxes overlapping by more than this share are the same face. */
  nmsThreshold: number;
  /** Candidates kept before NMS runs, highest score first. */
  topK: number;
}

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Read every grid cell of every stride and keep the cells that look like a
 * face. The network is anchor-free: one prior per cell, so a cell's index is
 * its position. The graph ends in a `Sigmoid`, which is why `cls` and `obj`
 * are used as-is while `bbox` and `kps` are raw offsets, and why the score is
 * the geometric mean of two probabilities.
 */
function collectCandidates(outputs: Outputs, opts: DecodeOptions): Face[] {
  const faces: Face[] = [];

  for (const stride of STRIDES) {
    const { cls, obj, bbox, kps } = outputs[stride];
    const cols = opts.padWidth / stride;
    const rows = opts.padHeight / stride;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const score = Math.sqrt(
          clamp01(cls[idx] ?? 0) * clamp01(obj[idx] ?? 0)
        );
        if (score < opts.scoreThreshold) continue;

        const b = idx * 4;
        const cx = (c + (bbox[b] ?? 0)) * stride;
        const cy = (r + (bbox[b + 1] ?? 0)) * stride;
        const w = Math.exp(bbox[b + 2] ?? 0) * stride;
        const h = Math.exp(bbox[b + 3] ?? 0) * stride;

        // Landmark offsets are relative to the cell corner, not to the box
        // centre: the one place where the bbox and kps heads disagree.
        const k = idx * 10;
        const point = (n: number): Point => ({
          x: ((kps[k + n * 2] ?? 0) + c) * stride,
          y: ((kps[k + n * 2 + 1] ?? 0) + r) * stride,
        });

        faces.push({
          box: { x: cx - w / 2, y: cy - h / 2, width: w, height: h },
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
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  const overlap = (right - left) * (bottom - top);
  return overlap / (a.width * a.height + b.width * b.height - overlap);
}

/**
 * Greedy non-maximum suppression, highest score first. `topK` truncates
 * before the loop, as OpenCV does: on a crowd that changes the answer, not
 * only the cost, because a face a truncated neighbour would have suppressed
 * survives.
 */
function suppress(candidates: Face[], opts: DecodeOptions): Face[] {
  const sorted = [...candidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topK);
  const kept: Face[] = [];
  for (const face of sorted) {
    if (kept.every((k) => iou(k.box, face.box) <= opts.nmsThreshold)) {
      kept.push(face);
    }
  }
  return kept;
}

/**
 * Decode one inference into faces, in pixels of the padded network frame.
 * The padding sits bottom-right only, so a face is already in the un-padded
 * frame and only the resize factor is left for the caller to undo.
 */
export function decodeOutputs(outputs: Outputs, opts: DecodeOptions): Face[] {
  return suppress(collectCandidates(outputs, opts), opts);
}
