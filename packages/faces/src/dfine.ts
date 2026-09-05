/**
 * Turning D-FINE's two raw output tensors into objects.
 *
 * D-FINE's own repository traces the postprocessing into the graph — its
 * `tools/deployment/export_onnx.py` wraps `cfg.postprocessor.deploy()` and the
 * result hands back decoded `labels`/`boxes`/`scores`. The export Hugging Face
 * publishes, which is the one this service ships, does not: it stops at
 * `logits [1,300,80]` **raw** and `pred_boxes [1,300,4]` in **cxcywh, normalised
 * 0..1**, with no `orig_target_sizes` input and no NMS. So the decode lives
 * here. `docs/research/kart-and-driver-subjects.md` Q5 records the correction
 * and Q11 re-confirmed it against the graph.
 *
 * Nothing in this file touches sharp or ONNX Runtime: it takes plain typed
 * arrays and returns plain numbers, which is what lets `scripts/objects-test.ts`
 * drive it with logits it wrote by hand. A decode that is wrong in an ordinary
 * way — a transposed index, a missing sigmoid, a centre read as a corner — still
 * returns plausible rectangles on a real photograph, and only arithmetic with a
 * known answer catches that.
 *
 * The 300 is the decoder's fixed query count, not a top-k selection, so nearly
 * every query answers something and near-duplicates are the norm rather than the
 * exception. Suppression is not optional here.
 */

/**
 * A rectangle in fractions of the image, 0..1 from the top-left.
 *
 * Fractions all the way through rather than pixels, because D-FINE's boxes are
 * already normalised and the image is stretch-resized to a square — so there is
 * no scale to undo and no aspect correction to get backwards. Spelled
 * `width`/`height` for the reason `yunet.ts` gives: it becomes a `SubjectBox` in
 * meco with no rename at the boundary (ADR-0002).
 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The 80 COCO classes in the order D-FINE emits them.
 *
 * Read from the model's own `config.json` `id2label` rather than from a list
 * found elsewhere: the ordering is the graph's contract, and the two COCO
 * namings differ exactly where it matters here. Index 3 is `motorbike` in this
 * export, not `motorcycle` — and `motorbike` is the class that finds a kart,
 * because COCO has no kart and resolves one to the nearest thing it knows.
 */
export const COCO_LABELS = [
  "person",
  "bicycle",
  "car",
  "motorbike",
  "aeroplane",
  "bus",
  "train",
  "truck",
  "boat",
  "traffic light",
  "fire hydrant",
  "stop sign",
  "parking meter",
  "bench",
  "bird",
  "cat",
  "dog",
  "horse",
  "sheep",
  "cow",
  "elephant",
  "bear",
  "zebra",
  "giraffe",
  "backpack",
  "umbrella",
  "handbag",
  "tie",
  "suitcase",
  "frisbee",
  "skis",
  "snowboard",
  "sports ball",
  "kite",
  "baseball bat",
  "baseball glove",
  "skateboard",
  "surfboard",
  "tennis racket",
  "bottle",
  "wine glass",
  "cup",
  "fork",
  "knife",
  "spoon",
  "bowl",
  "banana",
  "apple",
  "sandwich",
  "orange",
  "broccoli",
  "carrot",
  "hot dog",
  "pizza",
  "donut",
  "cake",
  "chair",
  "sofa",
  "pottedplant",
  "bed",
  "diningtable",
  "toilet",
  "tvmonitor",
  "laptop",
  "mouse",
  "remote",
  "keyboard",
  "cell phone",
  "microwave",
  "oven",
  "toaster",
  "sink",
  "refrigerator",
  "book",
  "clock",
  "vase",
  "scissors",
  "teddy bear",
  "hair drier",
  "toothbrush",
] as const;

/** How many classes the graph scores. Fixed by the export. */
export const CLASS_COUNT = COCO_LABELS.length;

/** How many object queries the decoder emits, whatever is in the picture. */
export const QUERY_COUNT = 300;

/** One thing the detector saw. */
export interface DetectedObject {
  /** The COCO class name, from `COCO_LABELS`. */
  label: string;
  /** Its index, kept because suppression groups by it and a name is not an index. */
  classId: number;
  score: number;
  box: Box;
}

/** The two tensors, already unwrapped to flat arrays. */
export interface DfineOutputs {
  /** `[queries * classes]`, raw — not sigmoided by the graph. */
  logits: ArrayLike<number>;
  /** `[queries * 4]`, cxcywh, normalised 0..1. */
  boxes: ArrayLike<number>;
}

export interface DecodeOptions {
  /** Minimum confidence to keep a query. */
  scoreThreshold: number;
  /** Two boxes of the *same* class overlapping by more than this are one object. */
  nmsThreshold: number;
  /** Objects kept after suppression, highest score first. */
  topK: number;
  /** Queries the graph emitted. Defaults to the export's fixed 300. */
  queries?: number;
  /** Classes the graph scored. Defaults to COCO's 80. */
  classes?: number;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * The logistic function, applied per class rather than a softmax over them.
 *
 * D-FINE is trained with a focal loss over independent per-class sigmoids, so
 * the 80 scores of one query do not sum to 1 and taking a softmax would be a
 * different — and quietly wrong — set of numbers. The largest is still the
 * largest either way, which is exactly why this is worth stating: the ranking
 * would survive the mistake and the threshold would not.
 */
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Every query that clears the threshold, at its best class.
 *
 * One class per query and not one detection per class: a query is a slot the
 * decoder has already committed to a single object, so keeping its second-best
 * class as well would put two boxes on one thing and let suppression pick
 * between them by score alone.
 */
function collectCandidates(outputs: DfineOutputs, opts: DecodeOptions): DetectedObject[] {
  const queries = opts.queries ?? QUERY_COUNT;
  const classes = opts.classes ?? CLASS_COUNT;
  const found: DetectedObject[] = [];

  for (let q = 0; q < queries; q++) {
    const base = q * classes;
    let bestClass = 0;
    let bestLogit = -Infinity;
    for (let c = 0; c < classes; c++) {
      const logit = outputs.logits[base + c] ?? -Infinity;
      if (logit > bestLogit) {
        bestLogit = logit;
        bestClass = c;
      }
    }
    // The sigmoid is monotonic, so the argmax could have been taken on the raw
    // logits and only the winner converted. It is not, because a threshold has
    // to be compared against a probability and reading these numbers while
    // debugging is far easier when they are one.
    const score = sigmoid(bestLogit);
    if (score < opts.scoreThreshold) continue;

    const b = q * 4;
    const cx = outputs.boxes[b] ?? 0;
    const cy = outputs.boxes[b + 1] ?? 0;
    const w = outputs.boxes[b + 2] ?? 0;
    const h = outputs.boxes[b + 3] ?? 0;

    // The network is free to put a centre or an edge slightly outside the image
    // — measured, `pred_boxes` reaches -0.059 and 1.054 — so the corners are
    // clamped and the size is taken from the clamped corners rather than kept.
    // A box hanging off the edge is not a region anything can crop.
    const left = clamp01(cx - w / 2);
    const top = clamp01(cy - h / 2);
    const right = clamp01(cx + w / 2);
    const bottom = clamp01(cy + h / 2);
    if (right <= left || bottom <= top) continue;

    found.push({
      label: COCO_LABELS[bestClass] ?? `class-${String(bestClass)}`,
      classId: bestClass,
      score,
      box: { x: left, y: top, width: right - left, height: bottom - top },
    });
  }

  return found;
}

/** Share of the union two boxes have in common. */
export function iou(a: Box, b: Box): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  const overlap = (right - left) * (bottom - top);
  return overlap / (a.width * a.height + b.width * b.height - overlap);
}

/**
 * Greedy non-maximum suppression, highest score first, **within a class**.
 *
 * Per class and not across all of them, and that is the whole point of this
 * function rather than a detail of it. A driver sits inside their kart, so the
 * `person` box and the `motorbike` box around the same subject overlap heavily
 * — often past any threshold worth using. Class-agnostic suppression would
 * delete whichever of the two scored lower, and the union rule meco composes
 * from them needs both. The failure would be silent: one plausible box instead
 * of two, and a Crop framed on the kart without its driver.
 */
function suppress(candidates: DetectedObject[], opts: DecodeOptions): DetectedObject[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const keptByClass = new Map<number, DetectedObject[]>();
  const kept: DetectedObject[] = [];

  for (const object of sorted) {
    const peers = keptByClass.get(object.classId) ?? [];
    if (peers.some((p) => iou(p.box, object.box) > opts.nmsThreshold)) continue;
    peers.push(object);
    keptByClass.set(object.classId, peers);
    kept.push(object);
    if (kept.length >= opts.topK) break;
  }

  return kept;
}

/**
 * Decode one inference into objects, in fractions of the image.
 *
 * `topK` truncates *after* suppression, unlike `decodeYunet` where OpenCV's own
 * order puts it before. There is no compatibility to preserve here, and cutting
 * first would let a survivor keep a box that a discarded higher-scoring
 * neighbour should have suppressed.
 */
export function decodeDfine(outputs: DfineOutputs, opts: DecodeOptions): DetectedObject[] {
  return suppress(collectCandidates(outputs, opts), opts);
}
