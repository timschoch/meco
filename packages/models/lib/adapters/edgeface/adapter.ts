import * as ort from "onnxruntime-node";
import type { AdapterRegion, DecodedImage } from "@meco/contracts";
import type { Enricher } from "../../enricher";
import { ModelSession } from "../../session";
import { adapterFile, readLicence } from "../files";
import { ALIGNED_SIZE, alignFace, inPixels, UnalignableFace } from "./align";

const NAME = "edgeface";

/**
 * Bumped by hand under contracts' rule: weights, preprocessing, thresholds,
 * runtime major. The weights are pinned by `weights.sha256` beside them.
 */
export const EDGEFACE = { name: NAME, version: "1" } as const;

/**
 * Exported from Idiap's pinned PyTorch checkpoint; `LICENCE.txt` beside it
 * records the checkpoint, the commit and the split licence.
 */
const WEIGHTS = "edgeface_xs_gamma_06.onnx";

/**
 * Length of a Face Print. Fixed by the network, not a setting — and asserted
 * on every print this Model emits, because identify gates on the length
 * (`PRINT_DIMENSIONS`, #174) and a print of the wrong shape must be refused
 * where it was made, not where it is compared.
 */
const PRINT_LENGTH = 512;

/**
 * EdgeFace's preprocessing is `ToTensor()` then `Normalize(0.5, 0.5)`: RGB,
 * channels-first, scaled to `[0, 1]` and then to `[-1, 1]`. The Hugging Face
 * card says the same thing in its own words — `rescale_factor: 1/255`, mean
 * and standard deviation `0.5`. Getting the range wrong does not fail; it
 * quietly returns Face Prints that match nothing.
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
  return new ort.Tensor("float32", data, [
    squares.length,
    3,
    ALIGNED_SIZE,
    ALIGNED_SIZE,
  ]);
}

/**
 * Scale a Face Print to unit length.
 *
 * The network's raw output has a magnitude that carries no identity — it
 * tracks how confident the model is, not who it is looking at. Normalising
 * here means a comparison is a dot product, and that every Face Print meco
 * stores is on the same scale as every other, whatever produced it.
 */
function l2Normalise(values: Float32Array): number[] {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return Array.from(values, (v) => v / norm);
}

/** A face Region this Model did align, and where it sits in the answer. */
interface AlignedFace {
  index: number;
  square: Buffer;
}

/**
 * The faces the warp accepted. A face it refuses is left out of the batch and
 * keeps its Region: the ArcFace warp cannot cut a square from every set of
 * landmarks, and before the prototype's issue #39 that refusal rejected the
 * whole call — so one such face in a nine-face photograph named nobody in it.
 * Only the warp's own refusal is caught by its own type; a libvips failure or
 * a bad argument is not a fact about one face and must still take the request
 * down.
 */
async function alignAll(
  image: DecodedImage,
  regions: AdapterRegion[],
  on: AdapterRegion["kind"]
): Promise<AlignedFace[]> {
  const aligned: AlignedFace[] = [];
  for (const [index, region] of regions.entries()) {
    if (region.kind !== on || !region.landmarks) continue;
    try {
      aligned.push({
        index,
        square: await alignFace(
          image,
          inPixels(region.landmarks, image.width, image.height)
        ),
      });
    } catch (err) {
      if (!(err instanceof UnalignableFace)) throw err;
    }
  }
  return aligned;
}

export function createEdgeface(): Enricher {
  const session = new ModelSession(adapterFile(NAME, WEIGHTS));
  /** Written once: the Kind it declares and the Kind it aligns cannot drift. */
  const on = "face";

  return {
    model: EDGEFACE,
    licence: readLicence(NAME),
    licenceId: "CC-BY-NC-SA-4.0",
    on,
    warm: async () => {
      await session.get();
    },
    isWarm: () => session.isWarm(),

    async run(
      image: DecodedImage,
      regions: AdapterRegion[]
    ): Promise<AdapterRegion[]> {
      const aligned = await alignAll(image, regions, on);
      // No aligned square, no batch: a batch of nothing has no answer to give,
      // and loading the session to ask it would be a cost for nobody.
      if (aligned.length === 0) return [...regions];

      // One inference for the batch and not one per face: a group photograph
      // of eight people should not pay eight session round trips.
      const model = await session.get();
      const results = await model.run({
        [model.inputNames[0]!]: toTensor(aligned.map((a) => a.square)),
      });
      const output = results[model.outputNames[0]!];
      if (!output) {
        throw new Error(`${WEIGHTS} returned no output tensor`);
      }

      // The 512 assertion, taken once for the whole batch: `values.length ===
      // faces * 512` holds exactly when every print sliced out below is 512
      // long. identify gates on the length (`PRINT_DIMENSIONS`, #174), so a
      // print of the wrong shape is refused where it is made rather than where
      // it is compared.
      const values = output.data as Float32Array;
      if (values.length !== aligned.length * PRINT_LENGTH) {
        throw new Error(
          `${WEIGHTS} returned ${values.length} floats for ${aligned.length} faces, and a Face Print is ${PRINT_LENGTH} long`
        );
      }

      // Scattered back to the caller's positions, never pushed in the batch's
      // order: the batch holds only the faces that aligned, and the answer has
      // to be the Regions that came in, in the order they came in.
      const answered = [...regions];
      for (const [n, { index }] of aligned.entries()) {
        const vector = l2Normalise(
          values.subarray(n * PRINT_LENGTH, (n + 1) * PRINT_LENGTH)
        );
        answered[index] = {
          ...regions[index]!,
          facePrint: { model: EDGEFACE, vector },
        };
      }
      return answered;
    },
  };
}
