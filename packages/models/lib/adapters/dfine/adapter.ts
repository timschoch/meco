import * as ort from "onnxruntime-node";
import sharp from "sharp";
import type { AdapterRegion, DecodedImage, RegionKind } from "@meco/contracts";
import type { Detector } from "../../detector";
import { ModelSession } from "../../session";
import { adapterFile, readLicence } from "../files";
import {
  BOXES_DIMS,
  clamp01,
  decodeOutputs,
  LOGITS_DIMS,
  type DetectedObject,
} from "./outputs";

const NAME = "dfine";

/**
 * Bumped by hand under contracts' rule: weights, preprocessing, class list,
 * thresholds, runtime major. The weights are pinned by `weights.sha256`.
 */
export const DFINE = { name: NAME, version: "1" } as const;

/**
 * fp32 and not the q4f16 build that is a third of the size: the smaller one
 * measured 2.3x slower and less accurate in the prototype (64 ms warm against
 * 28 ms, four fewer karts and two fewer drivers across 32 photographs).
 *
 * From `AnnotateIt/dfine-nano-coco-onnx` and deliberately not from
 * `onnx-community/dfine_n_coco-ONNX`: the latter declares no licence at all,
 * and its export predates the 2025-08-20 "Fix weights" correction of the base
 * checkpoint. `LICENCE.txt` beside the weights carries the whole chain.
 */
const WEIGHTS = "dfine_n_coco.onnx";

/**
 * The square the network is trained to see, from `preprocessor_config.json`.
 * Both dimensions are baked into the exported graph, so this is a fact about
 * the model and not a knob. The image is *stretched* into it rather than
 * letterboxed (`do_pad: false`), which is why a decoded fraction of the square
 * is the same fraction of the Decoded Image with no padding offset to undo.
 */
const INPUT_SIDE = 640;

/**
 * How confident the network has to be. Load-bearing, and measured: a kart is
 * small, low, half-occluded by its own driver and nothing like the motorbikes
 * COCO was labelled with, so it earns 0.28-0.48 rather than the 0.9 a dog gets.
 * `on-track-dark-visor.jpg`'s two karts score 0.284 and 0.280, so a floor at
 * 0.30 loses them both.
 */
const SCORE_THRESHOLD = 0.28;

/** Two boxes of one class overlapping by more than this share are one object. */
const NMS_THRESHOLD = 0.6;

/**
 * How many Regions one answer may carry. A paddock photograph in the fixtures
 * returns 41 honest detections; an Annotation is still not a place to put an
 * unbounded list.
 */
const TOP_K = 50;

/** Fractions are written to this many decimals. */
const DECIMALS = 6;
const round = (n: number): number => Number(n.toFixed(DECIMALS));

/**
 * COCO Labels to Region Kinds. This table and no other: it is
 * [`CONTEXT.md`, models](../../../../../CONTEXT.md#models) in code, and frame
 * composes the kart Subject on it, so a change here is a change frame sees.
 *
 * A `vehicle` is a road vehicle a person rides or drives. A Label absent from
 * this table emits no Region — `boat`, `aeroplane` and `train` among them. That
 * is not tidiness: on `on-track-dark-visor.jpg` D-FINE calls the track a `boat`
 * at 0.506 spanning 0.9239 x 0.2992 of the frame, which outweighs the true
 * `motorbike` at 0.294 by area and no score floor separates them. Eight COCO
 * vehicle classes reproduce the recorded kart Subject on 5 of 6 fixtures; these
 * five do it on 6 of 6 (measured by the frame agent on
 * `fixtures/karts/objects.json`, 6 Sep 2026).
 */
const KIND_OF_LABEL = new Map<string, RegionKind>([
  ["person", "person"],
  ["motorbike", "vehicle"],
  ["bicycle", "vehicle"],
  ["car", "vehicle"],
  ["bus", "vehicle"],
  ["truck", "vehicle"],
]);

/** The Kinds this adapter can emit, from the table, so the two cannot drift. */
const KINDS: RegionKind[] = [...new Set(KIND_OF_LABEL.values())];

/**
 * One detection as a Region, or nothing when the table drops its Label. The
 * Model's own word is kept in `label`; `kind` is what a caller selects on.
 */
function toRegion(object: DetectedObject): AdapterRegion | undefined {
  const kind = KIND_OF_LABEL.get(object.label);
  if (kind === undefined) return undefined;
  return {
    kind,
    label: object.label,
    box: {
      x: round(object.box.x),
      y: round(object.box.y),
      width: round(object.box.width),
      height: round(object.box.height),
    },
    score: round(clamp01(object.score)),
    model: DFINE,
  };
}

/**
 * Pack a raw RGB buffer as the tensor D-FINE was trained to see. Three things
 * here are the opposite of what yunet wants, and all three come from
 * `preprocessor_config.json`: RGB and not BGR (a Hugging Face export, not an
 * OpenCV one), rescaled to 0..1 (`do_rescale`, factor 1/255), and *not*
 * normalised (`do_normalize: false`, so the ImageNet mean and std the same file
 * lists are not applied — they are processor defaults, not this model's).
 * Subtracting them anyway still detects objects, just fewer and in slightly
 * wrong places, which is the failure a test on a photograph does not notice.
 */
function toTensor(rgb: Uint8Array): ort.Tensor {
  const plane = INPUT_SIDE * INPUT_SIDE;
  const data = new Float32Array(plane * 3);
  for (let p = 0, i = 0; p < plane; p++, i += 3) {
    data[p] = rgb[i]! / 255;
    data[plane + p] = rgb[i + 1]! / 255;
    data[plane * 2 + p] = rgb[i + 2]! / 255;
  }
  return new ort.Tensor("float32", data, [1, 3, INPUT_SIDE, INPUT_SIDE]);
}

/**
 * One named output tensor, checked to be the shape the decode walks.
 *
 * The dims and not only the type: the decode reads `logits` with a stride of
 * 80 and `pred_boxes` with a stride of 4, and a `[1,80,300]` export would
 * decode into plausible rectangles in the wrong places rather than throw. That
 * is the one failure a test on a photograph cannot see.
 */
function tensor(
  results: ort.InferenceSession.OnnxValueMapType,
  name: string,
  dims: readonly number[]
): Float32Array {
  const found = results[name];
  if (!(found?.data instanceof Float32Array)) {
    throw new Error(
      `dfine: ${WEIGHTS} answered no float32 ${name} — is this the right export?`
    );
  }
  if (String(found.dims) !== String(dims)) {
    throw new Error(
      `dfine: ${WEIGHTS} answered ${name} as [${found.dims.join(",")}], and the decode reads [${dims.join(",")}]`
    );
  }
  return found.data;
}

export function createDfine(): Detector {
  const session = new ModelSession(adapterFile(NAME, WEIGHTS));

  return {
    model: DFINE,
    licence: readLicence(NAME),
    licenceId: "Apache-2.0",
    kinds: KINDS,
    warm: async () => {
      await session.get();
    },
    isWarm: () => session.isWarm(),

    async run(image: DecodedImage): Promise<AdapterRegion[]> {
      // `fill`: stretched into the square, not letterboxed into it. That is
      // what the model was exported with, and it is what makes a decoded
      // fraction of the square a fraction of the photograph. `contain` would
      // put every box out by however much of the square was bars.
      const { data, info } = await sharp(image.data, {
        raw: { width: image.width, height: image.height, channels: 3 },
      })
        .resize({ width: INPUT_SIDE, height: INPUT_SIDE, fit: "fill" })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (info.channels !== 3) {
        throw new Error(
          `dfine: expected 3 channels after resize, got ${info.channels}`
        );
      }

      const model = await session.get();
      const results = await model.run({ pixel_values: toTensor(data) });

      const logits = tensor(results, "logits", LOGITS_DIMS);
      const boxes = tensor(results, "pred_boxes", BOXES_DIMS);

      return decodeOutputs(
        { logits, boxes },
        {
          scoreThreshold: SCORE_THRESHOLD,
          nmsThreshold: NMS_THRESHOLD,
          topK: TOP_K,
        }
      )
        .map(toRegion)
        .filter((region): region is AdapterRegion => region !== undefined);
    },
  };
}
