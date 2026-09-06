/**
 * Turning the CTC recogniser's output into a read.
 *
 * PP-OCR's recogniser answers a softmax over its symbols at every time step
 * along the crop's width. CTC's rule turns that into text: take the best
 * symbol per step, drop the blank, and collapse a symbol repeated across
 * neighbouring steps into one — `2 2 _ 4 4` is `24`. The confidence is the
 * mean of the kept steps' probabilities, PaddleOCR's own definition.
 *
 * The symbol table is `blank`, then the dictionary in file order, then a
 * space: PaddleOCR's `CTCLabelDecode` inserts exactly those two, which is why
 * a 95-line dictionary drives a 97-class head. Nothing here touches ONNX
 * Runtime.
 */

/** One text box as the recogniser read it. */
export interface Read {
  text: string;
  /** Mean probability of the kept steps; 0 when nothing was kept. */
  confidence: number;
}

/** The index CTC reserves for "no symbol here". */
const BLANK = 0;

/** `blank`, the dictionary, a space: the recogniser's classes in order. */
export function symbolTable(dictionary: string): string[] {
  const keys = dictionary.split("\n");
  if (keys.at(-1) === "") keys.pop();
  return ["blank", ...keys, " "];
}

/**
 * Greedy CTC decode of one crop's `[steps, classes]` softmax, flattened
 * row-major. `classes` must equal the symbol table's length; the adapter
 * checks it against the tensor, because a dictionary one line short would
 * still decode — into the wrong digits.
 */
export function ctcDecode(
  probs: ArrayLike<number>,
  steps: number,
  classes: number,
  symbols: string[]
): Read {
  let previous = BLANK;
  let text = "";
  let sum = 0;
  let kept = 0;
  for (let t = 0; t < steps; t++) {
    const base = t * classes;
    let best = BLANK;
    let bestP = probs[base] ?? 0;
    for (let c = 1; c < classes; c++) {
      const p = probs[base + c] ?? 0;
      if (p > bestP) {
        bestP = p;
        best = c;
      }
    }
    if (best !== BLANK && best !== previous) {
      text += symbols[best]!;
      sum += bestP;
      kept++;
    }
    previous = best;
  }
  return { text, confidence: kept === 0 ? 0 : sum / kept };
}

/**
 * Whether a read is a race number: one to three digits and nothing else.
 * Leading zeros are kept as read. Anything with a letter, a sign, a space or a
 * fourth digit is livery, a sponsor or a watermark, and is no Number.
 */
export const isNumber = (text: string): boolean => /^[0-9]{1,3}$/.test(text);
