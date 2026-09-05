/**
 * Turning a detected face into a Face Print with EdgeFace on ONNX Runtime.
 *
 * A Face Print is 512 floats on the unit sphere. It is not a photograph and it
 * cannot be turned back into one, but it is still a biometric template of a
 * real person, which is why meco-faces computes them and never stores them: the
 * bytes arrive, the numbers leave, and nothing here remembers either.
 *
 * The whole of the recognition depends on the warp in `align.ts` rather than on
 * anything in this file. Feed the network a plain crop of the face box instead
 * of the aligned square and it still returns 512 confident-looking floats —
 * they simply stop being comparable between two photographs of one person.
 *
 * The weights are Idiap's `edgeface_xs_gamma_06`, exported from the pinned
 * PyTorch checkpoint by `scripts/export-edgeface.py` and committed. Their
 * licence is CC BY-NC-SA 4.0 while the code around them is BSD-3; that split is
 * an accepted MVP risk, recorded in `docs/plans/faces-and-subject-aware-crop.md`
 * and to be settled in its own ADR before this ships commercially.
 */
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-node";
import sharp from "sharp";

import { ALIGNED_SIZE, alignFace, inPixels, type RawImage } from "./align.js";
import type { Landmarks } from "./yunet.js";

export const EMBED_MODEL = {
  name: "edgeface",
  file: "edgeface_xs_gamma_06.onnx",
  /** The weights, not the code: `otroshi/edgeface` itself is BSD-3-Clause. */
  licence: "CC BY-NC-SA 4.0",
} as const;

const MODEL_PATH = fileURLToPath(new URL(`../models/${EMBED_MODEL.file}`, import.meta.url));

/** Length of a Face Print. Fixed by the network, not a setting. */
export const PRINT_LENGTH = 512;

/** A model that would not load. Not the caller's fault, and not a 400. */
export class EmbedModelLoadError extends Error {}

/**
 * What `/embed` needs to know about a face: only where its landmarks are.
 *
 * The box `/detect` returns is deliberately not used. ArcFace alignment is
 * defined entirely by the five points, and taking the box as well would invite
 * a caller to think the two have to agree.
 */
export interface FaceToEmbed {
  /** The five points as fractions of the image, exactly as `/detect` gives them. */
  landmarks: Landmarks;
}

/**
 * One session for the life of the process, memoised as the promise.
 *
 * Same shape as the detector's, and for the same two reasons: two requests
 * arriving before the first create settles must wait on one create rather than
 * start a second, and a create that fails has to drop the memo so a bad moment
 * at boot does not poison every request for the life of the container.
 */
let session: Promise<ort.InferenceSession> | undefined;

export function loadEmbedModel(): Promise<ort.InferenceSession> {
  session ??= ort.InferenceSession.create(MODEL_PATH).catch((err: unknown) => {
    session = undefined;
    throw new EmbedModelLoadError(`Could not load ${EMBED_MODEL.file}: ${String(err)}`);
  });
  return session;
}

/** Whether the session is already warm, for `/health` to report without forcing a load. */
export const isEmbedLoaded = () => session !== undefined;

/**
 * Decode an image to upright three-channel RGB, once, at full size.
 *
 * Full size and not the detector's 640 px: the aligned square is 112 px of the
 * *face*, and on a group photo that face may be a twentieth of the frame, so
 * resizing the photograph first would throw away the detail the warp exists to
 * keep. `.rotate()` applies EXIF orientation, which is what makes the fractions
 * from `/detect` — taken on the upright image — mean the same thing here.
 */
export async function decodeUpright(image: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(image).rotate().removeAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  if (info.channels !== 3) {
    throw new Error(`Expected three channels after decoding, got ${String(info.channels)}.`);
  }
  return { data, width: info.width, height: info.height };
}

/**
 * Pack aligned faces into the batch the network expects.
 *
 * EdgeFace's preprocessing is `ToTensor()` then `Normalize(0.5, 0.5)`: RGB,
 * channels-first, scaled to `[0, 1]` and then to `[-1, 1]`. The Hugging Face
 * card says the same thing in its own words — `rescale_factor: 1/255`, mean and
 * standard deviation `0.5`. Getting the range wrong does not fail; it quietly
 * returns Face Prints that match nothing.
 */
function toTensor(squares: Buffer[]): ort.Tensor {
  const plane = ALIGNED_SIZE * ALIGNED_SIZE;
  const data = new Float32Array(squares.length * plane * 3);
  squares.forEach((square, n) => {
    const base = n * plane * 3;
    for (let p = 0, i = 0; p < plane; p++, i += 3) {
      data[base + p] = square[i]! / 127.5 - 1;
      data[base + plane + p] = square[i + 1]! / 127.5 - 1;
      data[base + plane * 2 + p] = square[i + 2]! / 127.5 - 1;
    }
  });
  return new ort.Tensor("float32", data, [squares.length, 3, ALIGNED_SIZE, ALIGNED_SIZE]);
}

/**
 * Scale a Face Print to unit length.
 *
 * The network's raw output has a magnitude that carries no identity — it tracks
 * how confident the model is, not who it is looking at. Normalising here means
 * a comparison is a dot product, and that every Face Print meco stores is
 * already on the same scale as every other, whatever produced it.
 */
function l2Normalise(values: Float32Array): number[] {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return Array.from(values, (v) => v / norm);
}

/** One face the warp could not cut a square from, and what went wrong. */
export interface SkippedFace {
  /** Its position in the list the caller sent. */
  index: number;
  reason: string;
}

export interface EmbedResult {
  /**
   * One entry per face given, in the order they were given. `null` where the
   * face could not be embedded — never a shorter list, because the caller reads
   * this by position.
   */
  prints: (number[] | null)[];
  /** Empty in the ordinary case. One entry per `null` above, with the reason. */
  skipped: SkippedFace[];
}

/**
 * Embed every face given, in the order they were given.
 *
 * One inference for the batch rather than one per face: the alignment is the
 * expensive half on a small model, and a group photo of eight people should not
 * pay eight session round trips for it.
 *
 * **A face that cannot be aligned is a hole, not a failure of the request.** The
 * ArcFace warp refuses landmarks it cannot cut a 112 px square from, and before
 * issue #39 that refusal rejected the whole call — so one such face in a nine-face
 * photograph meant meco named nobody in it, including the eight faces that were
 * fine. Worse, it degraded with crowd size, which is exactly where recognising
 * people matters most.
 *
 * So the alignment is done per face and its failure is recorded rather than
 * thrown. The network still sees one batch, of the faces that survived; if none
 * did it is not loaded at all, because a batch of nothing has no answer to give.
 */
export async function embedFaces(image: Buffer, faces: FaceToEmbed[]): Promise<EmbedResult> {
  if (faces.length === 0) return { prints: [], skipped: [] };

  const upright = await decodeUpright(image);
  const aligned = await Promise.all(
    faces.map(async (face) => {
      try {
        return {
          square: await alignFace(upright, inPixels(face.landmarks, upright.width, upright.height)),
        };
      } catch (err) {
        // Only the warp's own refusal. A model that will not load, or a buffer
        // that is not an image, is not a fact about one face and must still take
        // the request down — swallowing those would report a photograph full of
        // holes when the truth is that the service is broken.
        if (err instanceof EmbedModelLoadError) throw err;
        return { reason: (err as Error).message };
      }
    }),
  );

  const usable = aligned.flatMap((a, index) => (a.square ? [{ index, square: a.square }] : []));
  const skipped = aligned.flatMap((a, index) =>
    a.square ? [] : [{ index, reason: a.reason ?? "The face could not be aligned." }],
  );
  const prints: (number[] | null)[] = faces.map(() => null);
  if (usable.length === 0) return { prints, skipped };

  const model = await loadEmbedModel();
  const results = await model.run({
    [model.inputNames[0]!]: toTensor(usable.map((u) => u.square)),
  });
  const output = results[model.outputNames[0]!];
  if (!output) throw new EmbedModelLoadError(`${EMBED_MODEL.file} returned no output tensor.`);

  const values = output.data as Float32Array;
  if (values.length !== usable.length * PRINT_LENGTH) {
    throw new Error(
      `Expected ${String(usable.length * PRINT_LENGTH)} floats back, got ${String(values.length)}.`,
    );
  }
  // Scattered back to the caller's positions, not pushed in the batch's order:
  // the batch is only the faces that aligned, and `prints[i]` has to belong to
  // `faces[i]` however many holes are in between.
  usable.forEach((u, n) => {
    prints[u.index] = l2Normalise(values.subarray(n * PRINT_LENGTH, (n + 1) * PRINT_LENGTH));
  });
  return { prints, skipped };
}
