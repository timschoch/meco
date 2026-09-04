/**
 * Putting a detected face on the 112x112 template EdgeFace was trained on.
 *
 * Every ArcFace-family model expects the same thing: not a crop of the face
 * box, but the face resampled by a *similarity transform* that lands its five
 * landmarks on a fixed set of canonical points. Two photographs of one person
 * only produce comparable Face Prints if both went through this warp — it is
 * what removes scale, in-plane rotation and position before the network ever
 * sees the pixels, so the embedding is free to be about the face.
 *
 * Python does this with `skimage.transform.SimilarityTransform` plus
 * `cv2.warpAffine`. Here it is a closed-form fit and `sharp.affine()`, which is
 * what keeps OpenCV — a second image stack and a second ML runtime — out of the
 * image entirely.
 *
 * Nothing here loads a model. It takes raw RGB and returns raw RGB, so the
 * geometry can be tested against points a script draws rather than against a
 * face nobody can measure.
 */
import sharp from "sharp";

import type { Landmarks, Point } from "./yunet.js";

/** The square the model is fed. Not a parameter: the network's input is fixed. */
export const ALIGNED_SIZE = 112;

/**
 * Where the five landmarks have to land, in pixels of the 112x112 square.
 *
 * This is InsightFace's `arcface_dst` from `utils/face_align.py`, and the same
 * array appears hardcoded in OpenCV's `face_recognize.cpp`. EdgeFace reaches it
 * by a third route: its bundled `mtcnn_pytorch` template is a 96x112 crop whose
 * x coordinates gain 8.0 under `default_square=True`, which lands on these
 * numbers to the digit. Three independent sources, one template.
 *
 * The order is YuNet's own landmark order, so a detected face feeds straight
 * through with no reordering — as OpenCV's `alignCrop` also does.
 */
export const ARCFACE_DST: Landmarks = {
  rEye: { x: 38.2946, y: 51.6963 },
  lEye: { x: 73.5318, y: 51.5014 },
  nose: { x: 56.0252, y: 71.7366 },
  rMouth: { x: 41.5493, y: 92.3655 },
  lMouth: { x: 70.7299, y: 92.2041 },
};

/** The five points in the order the transform consumes them. */
export const asPoints = (l: Landmarks): Point[] => [l.rEye, l.lEye, l.nose, l.rMouth, l.lMouth];

/**
 * An affine map as its two rows: `[[a, b, tx], [c, d, ty]]`.
 *
 * Only similarity transforms are ever built here, so `d === a` and `c === -b`,
 * but the general shape is what `affine()` and the inverse both want.
 */
export type Matrix = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
];

export const applyMatrix = (m: Matrix, p: Point): Point => ({
  x: m[0][0] * p.x + m[0][1] * p.y + m[0][2],
  y: m[1][0] * p.x + m[1][1] * p.y + m[1][2],
});

/**
 * The similarity transform that best carries `src` onto `dst`, least squares.
 *
 * A similarity has four degrees of freedom — rotation, uniform scale and two
 * translations — so five point pairs are over-determined and the fit leaves a
 * residual on a face whose landmarks are not arranged exactly like the
 * template's. That is the point: the warp is allowed to be wrong about the
 * nose, and forbidden to shear or stretch the face to be right about it.
 *
 * Reflection is excluded by construction — the rotation block is built as
 * `[[a, -b], [b, a]]` rather than fitted freely — which is what stops a face
 * from being mirrored when the detector puts the eyes in an unusual place.
 *
 * This is the closed form of Umeyama's method for the no-reflection case, and
 * it agrees with OpenCV's SVD implementation to floating-point noise.
 */
export function similarityTransform(src: Point[], dst: Point[]): Matrix {
  if (src.length !== dst.length || src.length < 2) {
    throw new Error("A similarity fit needs at least two matched point pairs.");
  }
  const n = src.length;
  const mean = (points: Point[]) => ({
    x: points.reduce((sum, p) => sum + p.x, 0) / n,
    y: points.reduce((sum, p) => sum + p.y, 0) / n,
  });
  const s = mean(src);
  const d = mean(dst);

  let den = 0;
  let num1 = 0;
  let num2 = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i]!.x - s.x;
    const y = src[i]!.y - s.y;
    const u = dst[i]!.x - d.x;
    const v = dst[i]!.y - d.y;
    den += x * x + y * y;
    num1 += x * u + y * v;
    num2 += x * v - y * u;
  }
  if (den === 0) {
    throw new Error("Every source landmark is in the same place — no transform can be fitted.");
  }

  const a = num1 / den;
  const b = num2 / den;
  return [
    [a, -b, d.x - (a * s.x - b * s.y)],
    [b, a, d.y - (b * s.x + a * s.y)],
  ];
}

/** The map back from the aligned square to the source image. */
export function invertMatrix(m: Matrix): Matrix {
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  if (det === 0) throw new Error("The transform collapses the image and cannot be inverted.");
  const a = m[1][1] / det;
  const b = -m[0][1] / det;
  const c = -m[1][0] / det;
  const d = m[0][0] / det;
  return [
    [a, b, -(a * m[0][2] + b * m[1][2])],
    [c, d, -(c * m[0][2] + d * m[1][2])],
  ];
}

/** An upright image already decoded to three-channel RGB. */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

/** A rectangle in image pixels, in the shape `sharp.extract` wants. */
interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The top-left corner libvips will give the warped image.
 *
 * `affine()` takes a 2x2 matrix and expresses translation through `odx`/`ody`,
 * and libvips fixes the output canvas from the *linear part alone*:
 * `vips__transform_set_area()` runs before `odx`/`ody` are assigned, so
 * translation slides content around inside a canvas of a size already decided.
 * Adding this corner back into `odx` is what turns "somewhere in a canvas of
 * libvips's choosing" into "destination pixel (0, 0) is output pixel (0, 0)".
 *
 * The four corners mirror `transform_rect()` in libvips's `transform.c`, and so
 * does the rounding: it is `VIPS_ROUND_INT`, round-to-nearest-away-from-zero,
 * and *not* a floor. The difference is one pixel — the whole warp comes out a
 * pixel off whenever the corner lands on a negative fraction, which a rotation
 * makes it do most of the time. The width and height libvips derives are not
 * needed here, because the aligned square is sliced out of the top-left corner
 * of whatever comes back.
 */
const roundInt = (n: number) => Math.trunc(n > 0 ? n + 0.5 : n - 0.5);

function linearOrigin(m: Matrix, width: number, height: number): Point {
  const corners: Point[] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height },
  ];
  const linear = corners.map((p) => ({
    x: m[0][0] * p.x + m[0][1] * p.y,
    y: m[1][0] * p.x + m[1][1] * p.y,
  }));
  return {
    x: roundInt(Math.min(...linear.map((p) => p.x))),
    y: roundInt(Math.min(...linear.map((p) => p.y))),
  };
}

/**
 * The part of the source image the aligned square is made of.
 *
 * Without it the warp is priced against the whole photograph: libvips sizes the
 * output canvas from the transformed *input* rectangle, so aligning a small
 * face in a 12 MP group shot — an upscale of 6x or more — would allocate a
 * canvas of hundreds of megapixels to keep 112 of them.
 *
 * A pixel of margin is added because the resampler is bilinear and reads one
 * neighbour past the point it lands on. The rectangle is clipped to the image;
 * a face at the very edge simply loses the pixels that were never there, and
 * libvips fills the gap with its background, exactly as `cv2.warpAffine` does
 * with its default constant border.
 */
function preimage(m: Matrix, image: RawImage): Region {
  const back = invertMatrix(m);
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: ALIGNED_SIZE, y: 0 },
    { x: 0, y: ALIGNED_SIZE },
    { x: ALIGNED_SIZE, y: ALIGNED_SIZE },
  ].map((p) => applyMatrix(back, p));

  const left = Math.max(0, Math.floor(Math.min(...square.map((p) => p.x))) - 1);
  const top = Math.max(0, Math.floor(Math.min(...square.map((p) => p.y))) - 1);
  const right = Math.min(image.width, Math.ceil(Math.max(...square.map((p) => p.x))) + 1);
  const bottom = Math.min(image.height, Math.ceil(Math.max(...square.map((p) => p.y))) + 1);

  if (right <= left || bottom <= top) {
    throw new Error("The face's landmarks fall outside the image, so there is nothing to align.");
  }
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Warp one face onto the template and hand back the 112x112 square as raw RGB.
 *
 * `landmarks` are in pixels of `image`, which must already be upright: this
 * takes a decoded buffer rather than an encoded one precisely so that EXIF
 * rotation, resizing and cropping are all somebody else's problem. sharp's
 * pipeline order is fixed — `extract` always runs before `affine`, whatever
 * order the calls are made in — and a raw input has no orientation to apply, so
 * with a raw buffer the two steps mean what they look like they mean.
 *
 * The 112x112 is sliced out of the returned buffer rather than asked for with a
 * second `extract`, because a second `extract` would crop the source again. The
 * slice is free: the tensor wants a copy of these bytes either way.
 */
export async function alignFace(image: RawImage, landmarks: Landmarks): Promise<Buffer> {
  const full = similarityTransform(asPoints(landmarks), asPoints(ARCFACE_DST));
  const region = preimage(full, image);

  // Cropping first moves the origin, so the transform has to be re-fitted
  // against landmarks in the cropped frame rather than the whole image's.
  const shifted = asPoints(landmarks).map((p) => ({ x: p.x - region.left, y: p.y - region.top }));
  const m = similarityTransform(shifted, asPoints(ARCFACE_DST));
  const origin = linearOrigin(m, region.width, region.height);

  const { data, info } = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 3 },
  })
    .extract(region)
    // The default interpolator is `bilinear`, whatever the documentation says —
    // `lib/constructor.mjs` sets it. That is the one to keep: `cv2.warpAffine`
    // uses `INTER_LINEAR`, so the default is what gives InsightFace parity.
    .affine([
      [m[0][0], m[0][1]],
      [m[1][0], m[1][1]],
    ], { odx: m[0][2] + origin.x, ody: m[1][2] + origin.y })
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width < ALIGNED_SIZE || info.height < ALIGNED_SIZE) {
    throw new Error(
      `The warped face came back ${String(info.width)}x${String(info.height)}, ` +
        `smaller than the ${String(ALIGNED_SIZE)}px template.`,
    );
  }

  const out = Buffer.allocUnsafe(ALIGNED_SIZE * ALIGNED_SIZE * 3);
  for (let y = 0; y < ALIGNED_SIZE; y++) {
    data.copy(out, y * ALIGNED_SIZE * 3, y * info.width * 3, y * info.width * 3 + ALIGNED_SIZE * 3);
  }
  return out;
}

/** The transform `alignFace` will use, for a caller that wants to check the geometry. */
export const alignmentMatrix = (landmarks: Landmarks): Matrix =>
  similarityTransform(asPoints(landmarks), asPoints(ARCFACE_DST));
