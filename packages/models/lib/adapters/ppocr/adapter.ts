import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import type { AdapterRegion, DecodedImage, RegionKind } from "@meco/contracts";
import type { Detector } from "../../detector";
import { ModelSession } from "../../session";
import { adapterFile, readLicence } from "../files";
import { textBoxes, type TextBox } from "./detect";
import { ctcDecode, isNumber, symbolTable } from "./recognise";

const NAME = "ppocr";

/**
 * Bumped by hand under contracts' rule: weights, preprocessing, thresholds,
 * dictionary, runtime major. Two networks sit behind this one version because
 * neither answers a Region alone: the detector draws text boxes and the
 * recogniser reads them, and a Number is the pair's answer. Swapping either
 * bumps it. Both files are pinned by `weights.sha256`.
 */
export const PPOCR = { name: NAME, version: "1" } as const;

/**
 * The DB text detector. The v4 mobile export and not v3, v5 or v6: on the
 * owner's grid fixture it is the only one of the four that boxes the 37 px
 * `227` (#227, 6 Sep 2026). 4.7 MB.
 */
const DET_WEIGHTS = "ch_PP-OCRv4_det_mobile.onnx";

/**
 * The CTC recogniser. The English v4 mobile export, whose 95-symbol dictionary
 * is Latin letters, digits and punctuation, so a Number's label never comes
 * from a CJK glyph; the Chinese v4 and the v6 tiny recognisers read the same
 * numbers on the fixtures and were not preferred (#227). 7.7 MB.
 */
const REC_WEIGHTS = "en_PP-OCRv4_rec_mobile.onnx";

/** The recogniser's output symbols in index order, from the ONNX metadata. */
const DICTIONARY = "en_dict.txt";

/** The Kinds this adapter emits. */
const KINDS: RegionKind[] = ["number"];

/**
 * The detector's input is the Decoded Image at its own size, each side rounded
 * to a multiple of 32 as the network requires, never shrunk: shrinking the
 * long side to 960 px loses the grid fixture's `227` at every threshold
 * (#227). A 1600 px Decode Bound is the ceiling this pays for.
 */
const STRIDE = 32;

/** DB's thresholds, rapidocr 3.9.2's defaults for this model. */
const DETECT = {
  pixelThreshold: 0.3,
  boxThreshold: 0.5,
  unclipRatio: 1.6,
  minSidePx: 3,
};

/** The recogniser reads crops this many pixels high, whatever their width. */
const REC_HEIGHT = 48;

/**
 * The widest crop the recogniser is handed, in pixels at `REC_HEIGHT`. A
 * three-digit number is under 150; this is a guard against a text run the
 * width of the photograph, which is never a Number and would cost a second
 * of inference.
 */
const REC_MAX_WIDTH = 1280;

/**
 * A Number under this score is dropped. Measured on the committed fixtures
 * (6 Sep 2026): the paddock kart's `2` reads as `5` at 0.41, the street
 * kart's `35` reads right at 0.54, and every owner-fixture number scores 0.63
 * or above. One wrong read and one right read a tenth apart is thin evidence,
 * and the floor sits between them; it moves when a fixture says so.
 */
const SCORE_FLOOR = 0.5;

/** Fractions are written to this many decimals. */
const DECIMALS = 6;
const round = (n: number): number => Number(n.toFixed(DECIMALS));
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Pack raw RGB as the tensor both PP-OCR networks were trained to see: BGR,
 * because PaddleOCR reads with OpenCV, and `(x / 255 - 0.5) / 0.5`. The
 * normalisation is symmetric, so getting the channel order wrong would not
 * throw; it would read fewer numbers.
 */
function toTensor(rgb: Uint8Array, width: number, height: number): ort.Tensor {
  const plane = width * height;
  const data = new Float32Array(plane * 3);
  for (let p = 0, i = 0; p < plane; p++, i += 3) {
    data[p] = rgb[i + 2]! / 127.5 - 1;
    data[plane + p] = rgb[i + 1]! / 127.5 - 1;
    data[plane * 2 + p] = rgb[i]! / 127.5 - 1;
  }
  return new ort.Tensor("float32", data, [1, 3, height, width]);
}

/** The one output tensor of a session, checked to be float32 with `rank` dims. */
function output(
  results: ort.InferenceSession.OnnxValueMapType,
  weights: string,
  rank: number
): ort.Tensor {
  const found = Object.values(results)[0];
  if (!(found?.data instanceof Float32Array) || found.dims.length !== rank) {
    throw new Error(
      `ppocr: ${weights} answered no rank-${rank} float32 tensor — is this the right export?`
    );
  }
  return found;
}

export function createPpocr(): Detector {
  const detector = new ModelSession(adapterFile(NAME, DET_WEIGHTS));
  const recogniser = new ModelSession(adapterFile(NAME, REC_WEIGHTS));
  const symbols = symbolTable(
    readFileSync(adapterFile(NAME, DICTIONARY), "utf8")
  );

  const raw = (image: DecodedImage) =>
    sharp(image.data, {
      raw: { width: image.width, height: image.height, channels: 3 },
    });

  async function detect(image: DecodedImage): Promise<TextBox[]> {
    const width = Math.max(STRIDE, Math.round(image.width / STRIDE) * STRIDE);
    const height = Math.max(STRIDE, Math.round(image.height / STRIDE) * STRIDE);
    // `fill`: stretched to the stride, not padded. The stretch is under 3 %
    // and it is what makes a fraction of the map a fraction of the image.
    const { data } = await raw(image)
      .resize({ width, height, fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const session = await detector.get();
    const results = await session.run({ x: toTensor(data, width, height) });
    const map = output(results, DET_WEIGHTS, 4);
    if (map.dims[2] !== height || map.dims[3] !== width) {
      throw new Error(
        `ppocr: ${DET_WEIGHTS} answered a ${String(map.dims[3])}x${String(map.dims[2])} map for a ${width}x${height} input`
      );
    }
    return textBoxes(map.data as Float32Array, width, height, DETECT);
  }

  async function read(image: DecodedImage, box: TextBox) {
    const left = Math.floor(box.box.x * image.width);
    const top = Math.floor(box.box.y * image.height);
    const width = Math.max(
      1,
      Math.min(image.width - left, Math.ceil(box.box.width * image.width))
    );
    const height = Math.max(
      1,
      Math.min(image.height - top, Math.ceil(box.box.height * image.height))
    );
    // Aspect kept at 48 px high, as PaddleOCR resizes a crop; a run wider
    // than the guard is squeezed, and a squeezed sponsor line reads as noise
    // that the digit rule then drops.
    const recWidth = Math.min(
      REC_MAX_WIDTH,
      Math.max(8, Math.ceil((REC_HEIGHT * width) / height))
    );
    const { data } = await raw(image)
      .extract({ left, top, width, height })
      .resize({ width: recWidth, height: REC_HEIGHT, fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const session = await recogniser.get();
    const results = await session.run({
      x: toTensor(data, recWidth, REC_HEIGHT),
    });
    const probs = output(results, REC_WEIGHTS, 3);
    const [, steps, classes] = probs.dims as [number, number, number];
    if (classes !== symbols.length) {
      throw new Error(
        `ppocr: ${REC_WEIGHTS} scores ${String(classes)} symbols and ${DICTIONARY} lists ${String(symbols.length)}`
      );
    }
    return ctcDecode(probs.data as Float32Array, steps, classes, symbols);
  }

  return {
    model: PPOCR,
    licence: readLicence(NAME),
    licenceId: "Apache-2.0",
    kinds: KINDS,
    warm: async () => {
      await detector.get();
      await recogniser.get();
    },
    isWarm: () => detector.isWarm() && recogniser.isWarm(),

    async run(image: DecodedImage): Promise<AdapterRegion[]> {
      const regions: AdapterRegion[] = [];
      // One recogniser inference per box, in map order. Every run of text in
      // the photograph is read, and only the reads that are a Number are kept:
      // the sponsor names and the watermark are the price of finding the digits.
      for (const box of await detect(image)) {
        const { text, confidence } = await read(image, box);
        if (!isNumber(text)) continue;
        // The lower of the two networks' confidences: a crisp box read
        // hesitantly and a hesitant box read crisply are both doubtful.
        const score = round(clamp01(Math.min(box.score, confidence)));
        if (score < SCORE_FLOOR) continue;
        regions.push({
          kind: "number",
          label: text,
          box: {
            x: round(box.box.x),
            y: round(box.box.y),
            width: round(box.box.width),
            height: round(box.box.height),
          },
          score,
          model: PPOCR,
        });
      }
      return regions;
    },
  };
}
