/**
 * The fixture faces, read the one way everything agrees to read them.
 *
 * Three things have to name the same face by the same name: `align-dump.ts`
 * writes `fixtures/faces/aligned/<name>.png`, `export-edgeface.py` keys the
 * PyTorch reference by that filename, and `embed-test.ts` looks the reference up
 * again. Written out three times, the naming rule would drift and the lookup
 * would simply miss — a check that never runs rather than one that fails.
 *
 * So the rule lives here once, together with the ordering it depends on. It is
 * a script helper, not part of the service: nothing under `src/` reads
 * `expected.json`, and nothing here is in the image.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { detectFaces, type Face } from "../src/detect.js";
import { decodeUpright } from "../src/embed.js";
import type { RawImage } from "../src/align.js";
import type { Box } from "../src/yunet.js";

export const FIXTURES = fileURLToPath(new URL("../../../fixtures/faces/", import.meta.url));

/** One hand-marked face in `expected.json`. */
export interface MarkedFace {
  label: string;
  /** Which human this is; two faces sharing a letter are the same person. */
  person?: string;
  box: Box;
}

export interface Expected {
  tolerance: number;
  images: { file: string; note: string; faces: MarkedFace[] }[];
}

export const readExpected = async (): Promise<Expected> =>
  JSON.parse(await readFile(`${FIXTURES}expected.json`, "utf8")) as Expected;

/**
 * What the aligned square cut from one marked face is called.
 *
 * The contract between the two scripts and the Python export. Spaces become
 * hyphens because these are filenames and the labels are prose.
 */
export const alignedName = (file: string, label: string): string =>
  `${file.replace(/\.[a-z]+$/, "")}-${label.replace(/\s+/g, "-")}.png`;

/** One fixture face: the detection, the human's answer about it, and its name. */
export interface FixtureFace {
  name: string;
  person: string;
  face: Face;
  marked: MarkedFace;
}

export interface FixtureImage {
  file: string;
  /** The image decoded once, upright, for every face in it to be cut from. */
  upright: RawImage;
  faces: FixtureFace[];
}

/**
 * Detect every fixture face and pair each detection with the box a human drew.
 *
 * Both lists are sorted left to right and zipped, rather than matched by
 * nearest box as the detect test does. That is sound here and not there: the
 * detect test is allowed to see the wrong number of faces and has to say which
 * one moved, whereas this refuses to continue at all unless the counts agree —
 * and once they do, no two faces in any fixture are within the 3 % tolerance of
 * each other in x, so the two orders cannot disagree.
 */
export async function readFixtureFaces(): Promise<FixtureImage[]> {
  const expected = await readExpected();
  const images: FixtureImage[] = [];

  for (const image of expected.images) {
    if (image.faces.length === 0) continue;

    const bytes = await readFile(`${FIXTURES}${image.file}`);
    const detected = await detectFaces(bytes);
    if (detected.faces.length !== image.faces.length) {
      throw new Error(
        `${image.file}: detect found ${String(detected.faces.length)} faces but ` +
          `${String(image.faces.length)} are marked. Run the detect test first — the ` +
          `fixtures disagree with the detector.`,
      );
    }

    const marked = [...image.faces].sort((a, b) => a.box.x - b.box.x);
    const found = [...detected.faces].sort((a, b) => a.box.x - b.box.x);

    images.push({
      file: image.file,
      upright: await decodeUpright(bytes),
      faces: found.map((face, i) => ({
        name: alignedName(image.file, marked[i]!.label),
        person: marked[i]!.person ?? "?",
        face,
        marked: marked[i]!,
      })),
    });
  }

  return images;
}

/**
 * How alike two Face Prints are, from -1 to 1.
 *
 * Both are unit length, so this is the dot product and nothing else. It lives
 * in the test helpers rather than in the service because meco-faces does not
 * compare Face Prints — matching happens in meco, against a gallery this
 * service cannot see, and an exported comparison here would suggest otherwise.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Cannot compare Face Prints of length ${String(a.length)} and ${String(b.length)}.`,
    );
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}
