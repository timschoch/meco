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
import { Annotation, type Region } from "@meco/contracts";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/faces/", import.meta.url)
);

const read = (name: string): unknown =>
  JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8"));

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Box extends Point {
  readonly width: number;
  readonly height: number;
}

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

const printed = read("face-prints.json") as {
  readonly prints: readonly {
    readonly file: string;
    readonly label: string;
    readonly person: string;
    readonly print: readonly number[];
  }[];
};

/** The Model the fixture prints came from, and the one identify compares. */
const PRINT_MODEL = { name: "edgeface", version: "1" } as const;

/** The detector the fixture boxes came from. Its own Model, per ADR-0005. */
const BOX_MODEL = { name: "yunet", version: "1" } as const;

const centre = (box: Box): Point => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

const apart = (a: Box, b: Box): number =>
  Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y);

/**
 * A Face Print by the photograph and the face it was taken from. The print
 * files key on the hand-marked `label`, which is why the pairing above exists.
 */
export const printOf = (file: string, label: string): number[] => {
  const found = printed.prints.find(
    (one) => one.file === file && one.label === label
  );
  if (found === undefined) {
    throw new Error(`no fixture print for ${file} ${label}`);
  }
  return [...found.print];
};

/** Which human a fixture face is, as a letter. Two letters are two humans. */
export const personOf = (file: string, label: string): string => {
  const found = printed.prints.find(
    (one) => one.file === file && one.label === label
  );
  if (found === undefined) {
    throw new Error(`no fixture print for ${file} ${label}`);
  }
  return found.person;
};

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
