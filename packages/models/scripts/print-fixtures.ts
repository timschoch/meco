// Re-prints every committed fixture detection through the shipped Catalogue.
//
//   pnpm --filter @meco/models print:fixtures
//
// Writes `fixtures/faces/face-prints.json` and `fixtures/karts/face-prints.json`
// from the photographs beside them, and prints the drift of every new print
// against the one it replaces. identify's `tests/calibration.test.ts` sweeps
// those files, so this script is where the numbers in ADR-0012 Decision 3 come
// from; nothing else in the repository turns a photograph into a Face Print
// without a network.
//
// The two fixture sets get their faces from different places, and the reason
// is `expected.json`:
//
//   - `fixtures/faces/` is keyed by a hand-marked *label*, so the shipped
//     Detector runs here and every face it finds is paired to the human's mark
//     by nearest centre, inside `expected.json`'s own tolerance. A pairing
//     outside it throws. This is the whole shipped pipeline, and it is what
//     covers `astronaut-portrait-2.jpg`, which `detected.json` never recorded.
//   - `fixtures/karts/` is keyed by detection *index*: the human classified
//     the detections in the order `detected.json` records them. Re-detecting
//     there would renumber a judgement about which box holds a face, so the
//     recorded boxes and landmarks are read as they stand and only the
//     Enricher runs.
//
// The one decode is the host's own `decode`, so every print is taken at the
// Decode Bound, the size identify's Identifiable Face floor is judged in.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AdapterRegion, Box, Landmarks } from "@meco/contracts";
import { catalogue, decode, DECODE_BOUND } from "../catalogue";

/** The repository's fixtures folder, resolved by the build. */
declare const __FIXTURES__: string;

/** A Catalogue member by name, or a failure that says which one is missing. */
const inCatalogue = <T extends { model: { name: string } }>(
  role: string,
  members: readonly T[],
  name: string
): T => {
  const found = members.find((one) => one.model.name === name);
  if (found === undefined) {
    throw new Error(`the Catalogue holds no ${name} ${role}`);
  }
  return found;
};

const edgeface = inCatalogue("Enricher", catalogue.enrichers, "edgeface");
const yunet = inCatalogue("Detector", catalogue.detectors, "yunet");

/** The Detector the recorded boxes came from. Its own Model, per ADR-0005. */
const BOX_MODEL = { name: "yunet", version: "1" } as const;

interface DetectedFace {
  readonly box: Box;
  readonly score: number;
  readonly landmarks: Landmarks;
}

interface Detected {
  readonly images: Record<
    string,
    {
      readonly width: number;
      readonly height: number;
      readonly faces: readonly DetectedFace[];
    }
  >;
}

interface ExpectedFace {
  readonly label: string;
  readonly person?: string;
  readonly is?: "face" | "not-a-face";
  readonly reference?: boolean;
  readonly box?: Box;
}

interface Expected {
  readonly tolerance?: number;
  readonly images: readonly {
    readonly file: string;
    readonly faces: readonly ExpectedFace[];
  }[];
}

const readJson = async <T>(set: string, name: string): Promise<T> =>
  JSON.parse(await readFile(resolve(__FIXTURES__, set, name), "utf8")) as T;

/** One photograph's Regions, printed by the shipped Enricher at the bound. */
async function printsOf(
  set: string,
  file: string,
  faces?: readonly DetectedFace[]
): Promise<{ width: number; height: number; printed: AdapterRegion[] }> {
  const { image } = await decode(
    await readFile(resolve(__FIXTURES__, set, file))
  );
  const regions: AdapterRegion[] =
    faces === undefined
      ? await yunet.run(image)
      : faces.map((face) => ({
          kind: "face",
          label: "face",
          box: face.box,
          score: face.score,
          model: BOX_MODEL,
          landmarks: face.landmarks,
        }));
  return {
    width: image.width,
    height: image.height,
    printed: await edgeface.run(image, regions),
  };
}

/** The shorter side of a Region in the Decoded Image: identify's size floor. */
const pixelsOf = (box: Box, width: number, height: number): number =>
  Math.round(Math.min(box.width * width, box.height * height));

const centre = (box: Box) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

const apart = (a: Box, b: Box): number =>
  Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y);

const cosine = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

/**
 * The print of one Region, refused unless it is on the unit sphere.
 *
 * Every number this script reports is a dot product, which is the cosine only
 * for unit vectors. An adapter that ever emitted an unnormalised print would
 * make the drift and both sweeps quietly wrong rather than loudly wrong, so
 * the property they rest on is checked once, here, where the vectors are read.
 */
const unitPrintOf = (id: string, region: AdapterRegion): number[] => {
  const vector = region.facePrint?.vector;
  if (vector === undefined) {
    throw new Error(`${id}: the Enricher printed nothing`);
  }
  const norm = Math.sqrt(cosine(vector, vector));
  if (Math.abs(norm - 1) > 1e-6) {
    throw new Error(
      `${id}: the print has length ${norm}, and a Face Print is on the unit sphere`
    );
  }
  return [...vector];
};

/** The stamp both files carry: what produced these prints, and at what size. */
const PRINTED_BY = {
  model: edgeface.model,
  bound: DECODE_BOUND,
  onnxruntime: catalogue.onnxruntime,
} as const;

/** Every drift measured this run, so the worst and the median can be reported. */
const drift: { id: string; cosine: number }[] = [];

const record = (
  id: string,
  was: readonly number[] | undefined,
  now: readonly number[]
) => {
  if (was === undefined) return;
  drift.push({ id, cosine: cosine(was, now) });
};

// --- fixtures/faces ---------------------------------------------------------
// Keyed by the hand-marked `label`, which is what `face-prints.json` keys on
// and what identify's fixtures pair a detection with. The pairing is nearest
// centre inside `expected.json`'s own tolerance, one detection per mark, so a
// drift in either file fails here rather than printing the wrong face.

interface FacePrint {
  readonly file: string;
  readonly label: string;
  readonly person: string;
  readonly print: readonly number[];
}

const facesExpected = await readJson<Expected>("faces", "expected.json");
const facesWas = await readJson<{ prints: readonly FacePrint[] }>(
  "faces",
  "face-prints.json"
);
const tolerance = facesExpected.tolerance;
if (tolerance === undefined) {
  throw new Error("fixtures/faces/expected.json names no tolerance");
}

const facePrints: FacePrint[] = [];
for (const marked of facesExpected.images) {
  if (marked.faces.length === 0) continue;
  const { printed } = await printsOf("faces", marked.file);

  const claimed = new Set<AdapterRegion>();
  for (const face of marked.faces) {
    if (face.box === undefined)
      throw new Error(`${marked.file} ${face.label} has no hand-marked box`);
    if (face.person === undefined) {
      throw new Error(
        `${marked.file} ${face.label} has no person letter in expected.json`
      );
    }
    // Nearest centre, each Region claimed once: two marks collapsing onto one
    // box is a suppression bug, and printing it twice would hide it.
    const box = face.box;
    const nearest = printed
      .filter((one) => one.kind === "face" && !claimed.has(one))
      .sort((a, b) => apart(a.box, box) - apart(b.box, box))[0];
    if (nearest === undefined) {
      throw new Error(
        `${marked.file}: the Detector found no face for ${face.label}`
      );
    }
    if (apart(nearest.box, box) > tolerance) {
      throw new Error(
        `${marked.file}: the face nearest ${face.label} is outside expected.json's tolerance`
      );
    }
    claimed.add(nearest);

    const id = `${marked.file} ${face.label}`;
    const print = unitPrintOf(id, nearest);
    record(
      id,
      facesWas.prints.find(
        (one) => one.file === marked.file && one.label === face.label
      )?.print,
      print
    );
    facePrints.push({
      file: marked.file,
      label: face.label,
      person: face.person,
      print,
    });
  }
}

await writeFile(
  resolve(__FIXTURES__, "faces/face-prints.json"),
  `${JSON.stringify(
    {
      $comment: [
        "The Face Print of every hand-marked fixture face, taken by the shipped",
        "EdgeFace Enricher over the faces the shipped YuNet Detector found, each",
        "paired to a hand-marked face in expected.json by nearest centre inside",
        "that file's own tolerance. Written by",
        "`pnpm --filter @meco/models print:fixtures`; do not edit by hand.",
        "printedBy records the Print Model, the Decode Bound the prints were",
        "taken at and the ONNX Runtime that ran it. identify refuses a print",
        "from any other Model, so a Catalogue bump forces a re-run of this",
        "script and of the sweeps in packages/identify/tests/calibration.test.ts.",
        "person is which human the face belongs to: two faces sharing a letter",
        "are the same human. It comes from expected.json.",
      ],
      printedBy: PRINTED_BY,
      prints: facePrints,
    },
    null,
    2
  )}\n`
);

// --- fixtures/karts ---------------------------------------------------------
// Keyed by detection index, because `expected.json` classifies the detections
// in the order `detected.json` records them and nothing sorts them. A
// detection the warp refuses carries no print and lands in `skipped`, which is
// the Uncompared Face the Not-a-Face rule has to survive.

interface KartPrint {
  readonly file: string;
  readonly index: number;
  readonly label: string;
  readonly is: "face" | "not-a-face";
  readonly reference: boolean;
  readonly person?: string;
  readonly score: number;
  readonly pixels: number;
  readonly print: readonly number[];
}

const kartsDetected = await readJson<Detected>("karts", "detected.json");
const kartsExpected = await readJson<Expected>("karts", "expected.json");
const kartsWas = await readJson<{ prints: readonly KartPrint[] }>(
  "karts",
  "face-prints.json"
);

const kartPrints: KartPrint[] = [];
const skipped: {
  file: string;
  index: number;
  label: string;
  reason: string;
}[] = [];

for (const image of kartsExpected.images) {
  const detectedImage = kartsDetected.images[image.file];
  if (detectedImage === undefined) {
    throw new Error(
      `${image.file} is classified and has no recorded detection`
    );
  }
  if (detectedImage.faces.length !== image.faces.length) {
    throw new Error(
      `${image.file}: ${detectedImage.faces.length} detections against ${image.faces.length} classifications`
    );
  }
  const { width, height, printed } = await printsOf(
    "karts",
    image.file,
    detectedImage.faces
  );

  for (const [index, marked] of image.faces.entries()) {
    const id = `${image.file}#${index}`;
    const face = detectedImage.faces[index]!;
    const region = printed[index];
    if (region?.facePrint === undefined) {
      skipped.push({
        file: image.file,
        index,
        label: marked.label,
        reason:
          "the Enricher could not warp a 112px square from these landmarks",
      });
      continue;
    }
    if (marked.is === undefined)
      throw new Error(`${id} has no classification in expected.json`);
    const print = unitPrintOf(id, region);
    record(
      id,
      kartsWas.prints.find(
        (one) => one.file === image.file && one.index === index
      )?.print,
      print
    );
    kartPrints.push({
      file: image.file,
      index,
      label: marked.label,
      is: marked.is,
      reference: marked.reference === true,
      ...(marked.person === undefined ? {} : { person: marked.person }),
      score: face.score,
      pixels: pixelsOf(face.box, width, height),
      print,
    });
  }
}

await writeFile(
  resolve(__FIXTURES__, "karts/face-prints.json"),
  `${JSON.stringify(
    {
      $comment: [
        "The Face Print of every kart-fixture detection the shipped EdgeFace",
        "Enricher could align, over the recorded detections in detected.json",
        "beside this file. Written by",
        "`pnpm --filter @meco/models print:fixtures`; do not edit by hand.",
        "printedBy records the Print Model, the Decode Bound and the ONNX",
        "Runtime. is says what a human decided the detection is and reference",
        "marks the print identify commits in lib/not-a-face-prints.ts; both come",
        "from expected.json beside this file, and this dump only copies them.",
        "pixels is the shorter side of the box in the Decoded Image, which is",
        "the size identify judges its Identifiable Face floor in.",
        "skipped lists the detections the warp refused: a real detection with no",
        "print, which is the Uncompared Face the Not-a-Face rule has to survive.",
        "packages/identify/tests/calibration.test.ts sweeps NOT_A_FACE_THRESHOLD",
        "over these prints.",
      ],
      printedBy: PRINTED_BY,
      prints: kartPrints,
      skipped,
    },
    null,
    2
  )}\n`
);

// --- what moved -------------------------------------------------------------
drift.sort((a, b) => a.cosine - b.cosine);
const median = drift[Math.floor(drift.length / 2)];
console.log(
  [
    `printed ${facePrints.length} face fixtures and ${kartPrints.length} kart detections`,
    `  ${skipped.length} skipped: ${skipped.map((one) => `${one.file}#${one.index}`).join(", ") || "none"}`,
    `  at ${PRINTED_BY.bound} px through ${PRINTED_BY.model.name}/${PRINTED_BY.model.version}, onnxruntime ${PRINTED_BY.onnxruntime}`,
    "",
    `drift against the prints replaced — ${drift.length} compared`,
    `  worst  ${drift[0]?.cosine.toFixed(6)} — ${drift[0]?.id}`,
    `  median ${median?.cosine.toFixed(6)} — ${median?.id}`,
    `  best   ${drift.at(-1)?.cosine.toFixed(6)} — ${drift.at(-1)?.id}`,
  ].join("\n")
);
for (const one of drift) console.log(`  ${one.cosine.toFixed(6)}  ${one.id}`);
