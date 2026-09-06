/**
 * The committed fixture prints, turned into the shapes identify is called with.
 *
 * Two files hold the fixture faces and neither holds both halves identify
 * needs. `fixtures/faces/detected.json` is a recorded detection: boxes,
 * landmarks and scores, in the order the detector returned them, with no word
 * for which human each face is. `fixtures/faces/expected.json` is the
 * hand-marked answer: a box per face with a `label` and a `person` letter.
 * `fixtures/faces/face-prints.json` keys its prints by that `label`. So the
 * detected face and its print are paired here, by nearest box centre, and the
 * pairing is asserted to be one-to-one and inside `expected.json`'s own
 * tolerance. A drift in either file fails the pairing rather than quietly
 * printing the wrong face.
 *
 * Everything built here is parsed with the contracts schema before it is
 * handed over, so a fixture that stops being a legal Annotation fails in this
 * package and not in a caller's.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Annotation, type Box, type Point, type Region } from "@meco/contracts";
import { PRINT_MODEL } from "../index";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/faces/", import.meta.url)
);

/**
 * The kart photographs: the other fixture set, and the only one holding
 * detections a human classified as not being faces at all
 * (`fixtures/karts/expected.json`). The Not-a-Face rule is calibrated on it.
 */
const KARTS = fileURLToPath(
  new URL("../../../fixtures/karts/", import.meta.url)
);

const readFrom = (directory: string, name: string): unknown =>
  JSON.parse(readFileSync(`${directory}${name}`, "utf8"));

const read = (name: string): unknown => readFrom(FIXTURES, name);

const readKart = (name: string): unknown => readFrom(KARTS, name);

/**
 * The cosine of two Face Prints, computed here and not imported: the suite
 * crosses `index.ts` only, and the arithmetic under test is not on it. Both
 * are on the unit sphere, so the dot product is the cosine.
 */
export const cosine = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

interface DetectedFace {
  readonly box: Box;
  readonly score: number;
  readonly landmarks: Record<string, Point>;
}

interface DetectedImage {
  readonly width: number;
  readonly height: number;
  readonly faces: readonly DetectedFace[];
}

const detected = read("detected.json") as {
  readonly images: Record<string, DetectedImage>;
};

const expected = read("expected.json") as {
  readonly tolerance: number;
  readonly images: readonly {
    readonly file: string;
    readonly faces: readonly {
      readonly label: string;
      readonly person: string;
      readonly box: Box;
    }[];
  }[];
};

/**
 * What took a set of fixture prints, as the dump recorded it. A number without
 * what it was measured on is a trap, so the calibration prints this beside its
 * table and asserts the Model is the one the constants belong to.
 */
export interface PrintedBy {
  readonly model: { readonly name: string; readonly version: string };
  /** The Decode Bound the photographs were decoded to before printing. */
  readonly bound: number;
  readonly onnxruntime: string;
}

/** One committed fixture face print, as `fixtures/faces/face-prints.json` holds it. */
export interface FacePrint {
  readonly file: string;
  readonly label: string;
  /** Which human, as a letter. Two prints sharing a letter are one Person. */
  readonly person: string;
  readonly print: readonly number[];
}

const printed = read("face-prints.json") as {
  readonly printedBy: PrintedBy;
  readonly prints: readonly FacePrint[];
};

/** Every committed fixture face print, in the order the dump wrote them. */
export const facePrints = (): readonly FacePrint[] => printed.prints;

/** What printed `fixtures/faces/face-prints.json`. */
export const facePrintsPrintedBy = (): PrintedBy => printed.printedBy;

/** The detector the fixture boxes came from. Its own Model, per ADR-0005. */
const BOX_MODEL = { name: "yunet", version: "1" } as const;

const centre = (box: Box): Point => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

const apart = (a: Box, b: Box): number =>
  Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y);

/**
 * One committed print, by the photograph and the face it was taken from. The
 * print file keys on the hand-marked `label`, which is why the pairing above
 * exists.
 */
const fixturePrint = (file: string, label: string) => {
  const found = printed.prints.find(
    (one) => one.file === file && one.label === label
  );
  if (found === undefined) {
    throw new Error(`no fixture print for ${file} ${label}`);
  }
  return found;
};

/** The Face Print of one fixture face. */
export const printOf = (file: string, label: string): number[] => [
  ...fixturePrint(file, label).print,
];

/** Which human a fixture face is, as a letter. Two letters are two humans. */
export const personOf = (file: string, label: string): string =>
  fixturePrint(file, label).person;

/** A stable Content Hash per fixture, so a test never invents 64 hex digits. */
export const hashOf = (name: string): string =>
  createHash("sha256").update(name).digest("hex");

export interface FixtureFace {
  /** The Region id this face got in the built Annotation. */
  readonly regionId: string;
  /** The hand-marked label, which is also the print file's key. */
  readonly label: string;
  /** Which human, as a letter. */
  readonly person: string;
}

export interface FixtureAnnotation {
  readonly annotation: Annotation;
  /** Every face in the Annotation, so a check names a face and not an index. */
  readonly faces: readonly FixtureFace[];
}

/** The face of one fixture photograph, by its hand-marked label. */
export const faceIn = (
  built: FixtureAnnotation,
  label: string
): FixtureFace => {
  const found = built.faces.find((one) => one.label === label);
  if (found === undefined) {
    throw new Error(`no fixture face labelled ${label}`);
  }
  return found;
};

/**
 * The Annotation of one fixture photograph: every detected face as a face
 * Region carrying the print of the human that face is.
 */
export const annotationOf = (file: string): FixtureAnnotation => {
  const image = detected.images[file];
  if (image === undefined) throw new Error(`no recorded detection for ${file}`);
  const marked = expected.images.find((one) => one.file === file);
  if (marked === undefined) throw new Error(`no hand-marked faces for ${file}`);

  const claimed = new Set<string>();
  const faces: FixtureFace[] = [];
  const regions: Region[] = image.faces.map((face, index) => {
    const nearest = [...marked.faces].sort(
      (a, b) => apart(a.box, face.box) - apart(b.box, face.box)
    )[0];
    if (nearest === undefined) {
      throw new Error(`${file} has a detected face and no hand-marked one`);
    }
    if (claimed.has(nearest.label)) {
      throw new Error(
        `${file}: two detected faces pair with the hand-marked ${nearest.label}`
      );
    }
    if (apart(nearest.box, face.box) > expected.tolerance) {
      throw new Error(
        `${file}: the detected face nearest ${nearest.label} is outside the fixture tolerance`
      );
    }
    claimed.add(nearest.label);

    const regionId = `face-${index + 1}`;
    faces.push({
      regionId,
      label: nearest.label,
      person: personOf(file, nearest.label),
    });
    return {
      id: regionId,
      kind: "face",
      label: "face",
      box: face.box,
      score: face.score,
      model: BOX_MODEL,
      landmarks: face.landmarks,
      facePrint: { model: PRINT_MODEL, vector: printOf(file, nearest.label) },
    } as Region;
  });

  return {
    // Parsed, not cast: the fixtures are files on disk, and the contracts
    // schema is what says they are still an Annotation.
    annotation: Annotation.parse({
      schema: 1,
      hash: hashOf(file),
      mime: "image/jpeg",
      width: image.width,
      height: image.height,
      producedBy: [BOX_MODEL, PRINT_MODEL],
      regions,
    }),
    faces,
  };
};

/**
 * One kart detection: what a human decided it is, how big it was in the
 * Decoded Image, and the print the aligner took of it.
 */
export interface KartPrint {
  /** `<file>#<index>`, the name ADR-0003's table uses. */
  readonly id: string;
  readonly file: string;
  readonly index: number;
  /** What a human saw in the box, cut out at 2.2× its own size. */
  readonly saw: string;
  /** The human's classification: a face somebody could be named by, or not. */
  readonly is: "face" | "not-a-face";
  /** Whether this is the print identify commits as a Not-a-Face Print. */
  readonly reference: boolean;
  /** The shorter side in the Decoded Image, as the dump recorded it. */
  readonly pixels: number;
  readonly vector: readonly number[];
}

const kartPrinted = readKart("face-prints.json") as {
  readonly printedBy: PrintedBy;
  readonly prints: readonly {
    readonly file: string;
    readonly index: number;
    readonly label: string;
    readonly is: "face" | "not-a-face";
    readonly reference?: boolean;
    readonly pixels: number;
    readonly print: readonly number[];
  }[];
};

/**
 * The human's classification of every kart detection, in detection order
 * (`fixtures/karts/expected.json` says so, and nothing sorts them). This file
 * and not the print dump is the ground truth: `is` and `reference` are a
 * judgement about a photograph, and the print file merely copies them.
 */
const kartExpected = readKart("expected.json") as {
  readonly images: readonly {
    readonly file: string;
    readonly note?: string;
    readonly faces: readonly {
      readonly label: string;
      readonly is: "face" | "not-a-face";
      readonly reference?: boolean;
    }[];
  }[];
};

/**
 * Every committed kart print, in the order the dump wrote them, joined onto
 * the human's classification. The whole ground truth the Not-a-Face threshold
 * is measured against.
 *
 * A print the classification disagrees with throws here rather than quietly
 * changing what the sweep measures: marking a new detection `reference: true`
 * in `expected.json` alone has to fail loudly, not commit nothing.
 */
const KART_PRINTS = kartPrinted.prints.map((one): KartPrint => {
  const id = `${one.file}#${one.index}`;
  const image = kartExpected.images.find((each) => each.file === one.file);
  const marked = image?.faces[one.index];
  if (marked === undefined) {
    throw new Error(`${id} has a print and no hand-marked classification`);
  }
  if (marked.label !== one.label || marked.is !== one.is) {
    throw new Error(
      `${id} is "${marked.is}" in expected.json and "${one.is}" in face-prints.json`
    );
  }
  if ((marked.reference === true) !== (one.reference === true)) {
    throw new Error(
      `${id} is marked reference in one fixture file and not the other`
    );
  }
  return {
    id,
    file: one.file,
    index: one.index,
    saw: marked.label,
    is: marked.is,
    reference: marked.reference === true,
    pixels: one.pixels,
    vector: one.print,
  };
});

/** Every committed kart print. */
export const kartPrints = (): readonly KartPrint[] => KART_PRINTS;

/** What printed `fixtures/karts/face-prints.json`. */
export const kartPrintsPrintedBy = (): PrintedBy => kartPrinted.printedBy;

/** One kart print by `<file>#<index>`. */
export const kartPrint = (id: string): KartPrint => {
  const found = KART_PRINTS.find((one) => one.id === id);
  if (found === undefined) throw new Error(`no kart print ${id}`);
  return found;
};

/** Every photograph in `fixtures/karts/` a print was taken from. */
export const kartPhotographs = (): readonly string[] => [
  ...new Set(KART_PRINTS.map((one) => one.file)),
];

const kartDetected = readKart("detected.json") as {
  readonly images: Record<string, DetectedImage>;
};

/** One detection of a kart photograph, as it lands in the Annotation. */
export interface KartFace {
  readonly regionId: string;
  /** `<file>#<index>`, so a check names the detection ADR-0003 names. */
  readonly id: string;
  /** The human's classification, or absent when the print file skipped it. */
  readonly is?: "face" | "not-a-face";
}

export interface KartAnnotation {
  readonly annotation: Annotation;
  readonly faces: readonly KartFace[];
}

/**
 * The Annotation of one kart photograph: every recorded detection as a face
 * Region, carrying the print the dump took of it. A detection the aligner
 * could not cut a square from (`skipped` in the print file) carries no print,
 * which is exactly the Uncompared Face the rule has to survive.
 *
 * Region ids follow the detection order, so `face-1` is `#0`: the same face
 * ADR-0003's table names.
 */
export const kartAnnotationOf = (file: string): KartAnnotation => {
  const image = kartDetected.images[file];
  if (image === undefined) throw new Error(`no recorded detection for ${file}`);

  const faces: KartFace[] = [];
  const regions = image.faces.map((face, index) => {
    const printed = KART_PRINTS.find(
      (one) => one.file === file && one.index === index
    );
    const regionId = `face-${index + 1}`;
    faces.push({
      regionId,
      id: `${file}#${index}`,
      ...(printed === undefined ? {} : { is: printed.is }),
    });
    return {
      id: regionId,
      kind: "face",
      label: "face",
      box: face.box,
      score: face.score,
      model: BOX_MODEL,
      landmarks: face.landmarks,
      ...(printed === undefined
        ? {}
        : { facePrint: { model: PRINT_MODEL, vector: [...printed.vector] } }),
    };
  });

  return {
    annotation: Annotation.parse({
      schema: 1,
      hash: hashOf(file),
      mime: "image/jpeg",
      width: image.width,
      height: image.height,
      producedBy: [BOX_MODEL, PRINT_MODEL],
      regions,
    }),
    faces,
  };
};

/** The Region id one kart detection got, by `<file>#<index>`. */
export const kartRegionId = (built: KartAnnotation, id: string): string => {
  const found = built.faces.find((one) => one.id === id);
  if (found === undefined) throw new Error(`no kart detection ${id}`);
  return found.regionId;
};

/** Every same-human and different-human pair among the committed prints. */
export const printPairs = (): {
  readonly samePerson: { pair: string; similarity: number }[];
  readonly strangers: { pair: string; similarity: number }[];
} => {
  const samePerson: { pair: string; similarity: number }[] = [];
  const strangers: { pair: string; similarity: number }[] = [];
  for (const [index, a] of printed.prints.entries()) {
    for (const b of printed.prints.slice(index + 1)) {
      const similarity = a.print.reduce(
        (sum, value, i) => sum + value * (b.print[i] ?? 0),
        0
      );
      const entry = {
        pair: `${a.file} ${a.label} / ${b.file} ${b.label}`,
        similarity,
      };
      (a.person === b.person ? samePerson : strangers).push(entry);
    }
  }
  return { samePerson, strangers };
};
