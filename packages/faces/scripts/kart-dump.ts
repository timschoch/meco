/**
 * Record what meco-faces sees in `fixtures/karts/`, and commit the one print
 * meco needs in its own source.
 *
 * Three artefacts, all generated, all committed, and none of them a claim on its
 * own — `pnpm test:embed` re-runs the model over the same fixtures and refuses
 * to pass unless every one of them still matches:
 *
 * - `fixtures/karts/detected.json` — the detections, so `scripts/http-probe.ts`
 *   can serve a helmet to meco without loading ONNX Runtime. The sibling of
 *   `fixtures/faces/detected.json` and the same shape.
 * - `fixtures/karts/face-prints.json` — the Face Print of every detection that
 *   can be aligned, carrying the human's verdict from `expected.json`. This is
 *   what `scripts/match-calibration.ts` sweeps the Not-a-Face threshold over.
 * - `src/not-a-face-prints.ts` — the Not-a-Face Prints meco ships.
 *
 * The last one is a script in this package writing a file in meco's source, and
 * that deserves the objection it invites. It is here because meco cannot compute
 * a Face Print: the embedder is in this package and ADR-0002 keeps ONNX Runtime
 * out of meco's dependency tree. The alternative is a number nobody can
 * regenerate. The generated file says where it came from, and the check in
 * `embed-test.ts` fails if it ever stops agreeing with the model.
 *
 * Re-run with `pnpm --filter meco-faces dump:karts` whenever the kart fixtures,
 * the alignment or either model change.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { detectFaces, type Face } from "../src/detect.js";
import { embedFaces } from "../src/embed.js";

export const KARTS = fileURLToPath(new URL("../../../fixtures/karts/", import.meta.url));
const SRC = fileURLToPath(new URL("../../../src/", import.meta.url));

/** One detection as a human classified it. See `fixtures/karts/expected.json`. */
export interface MarkedKartFace {
  label: string;
  is: "face" | "not-a-face";
  /** Set on the one detection whose print meco ships. */
  reference?: boolean;
  /** Two detections sharing a letter are the same human. */
  person?: string;
}

export interface KartExpected {
  images: { file: string; note: string; faces: MarkedKartFace[] }[];
}

/** One committed kart Face Print, with everything a calibration needs about it. */
export interface KartPrint {
  file: string;
  /** Position in the detection order, which is the order `detected.json` records. */
  index: number;
  label: string;
  is: "face" | "not-a-face";
  reference: boolean;
  person?: string;
  /** Detector confidence, for the record: it does not separate these two classes. */
  score: number;
  /** The face's shorter side in pixels of the fixture, the frame `MIN_FACE_PX` judges. */
  pixels: number;
  print: number[];
}

export const readKartExpected = async (): Promise<KartExpected> =>
  JSON.parse(await readFile(`${KARTS}expected.json`, "utf8")) as KartExpected;

/** Every number in a detection, rounded the way `detected.json` rounds them. */
const round6 = (n: number) => +n.toFixed(6);
const recordFace = (f: Face) => ({
  box: {
    x: round6(f.box.x),
    y: round6(f.box.y),
    width: round6(f.box.width),
    height: round6(f.box.height),
  },
  landmarks: Object.fromEntries(
    Object.entries(f.landmarks).map(([name, p]) => [name, { x: round6(p.x), y: round6(p.y) }]),
  ),
  score: round6(f.score),
});

const expected = await readKartExpected();
const detections: Record<string, unknown> = {};
const prints: KartPrint[] = [];
/** Detections a human classified but the aligner could not cut a square from. */
const unalignable: string[] = [];

for (const image of expected.images) {
  const bytes = await readFile(`${KARTS}${image.file}`);
  const found = await detectFaces(bytes);

  if (found.faces.length !== image.faces.length) {
    throw new Error(
      `${image.file}: detect found ${String(found.faces.length)} faces but ` +
        `${String(image.faces.length)} are classified in expected.json. Reclassify before ` +
        `re-recording — the file and the detector disagree about what is in the photograph.`,
    );
  }
  detections[image.file] = {
    width: found.width,
    height: found.height,
    faces: found.faces.map(recordFace),
  };

  for (const [index, face] of found.faces.entries()) {
    const marked = image.faces[index]!;
    let print: number[];
    try {
      [print] = (await embedFaces(bytes, [{ landmarks: face.landmarks }])) as [number[]];
    } catch (err) {
      // A face the ArcFace warp cannot cut a 112 px square from has no Face
      // Print at all, so there is nothing to commit and nothing to calibrate on.
      // Recorded rather than swallowed: it is a real detection meco can never
      // name, and a reader of this file should not have to count to notice.
      unalignable.push(`${image.file}#${String(index)} — ${(err as Error).message}`);
      continue;
    }
    prints.push({
      file: image.file,
      index,
      label: marked.label,
      is: marked.is,
      reference: marked.reference === true,
      ...(marked.person ? { person: marked.person } : {}),
      score: round6(face.score),
      pixels: Math.round(
        Math.min(face.box.width * found.width, face.box.height * found.height),
      ),
      print,
    });
  }
}

await writeFile(
  `${KARTS}detected.json`,
  `${JSON.stringify(
    {
      $comment: [
        "Recorded answers from a real POST /detect against meco-faces, for every",
        "photograph in fixtures/karts/. The sibling of fixtures/faces/detected.json,",
        "the same shape, and there for the same reason: meco's own tests serve a",
        "helmet to the matcher without loading ONNX Runtime.",
        "This is a recording, not a claim about the detector. What each detection",
        "actually is was decided by a human and lives in expected.json beside this",
        "file. Every number is a fraction of the image, rounded to six decimals.",
        "Re-record with `pnpm --filter meco-faces dump:karts`.",
      ],
      images: detections,
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  `${KARTS}face-prints.json`,
  `${JSON.stringify(
    {
      $comment: [
        "The Face Print of every kart-fixture detection the aligner can cut a",
        "square from, from meco-faces' own ONNX path, written by",
        "packages/faces/scripts/kart-dump.ts.",
        "is says what a human decided the detection is; reference marks the one",
        "print meco ships in src/not-a-face-prints.ts. Both come from",
        "expected.json beside this file.",
        "meco's scripts/match-calibration.ts measures the Not-a-Face threshold",
        "over these, which is why they are committed: the calibration needs no",
        "model and no network. Kept current by `pnpm test:embed`.",
        ...(unalignable.length > 0
          ? [
              "Detections with no print here, because the ArcFace warp could not cut",
              "a 112 px square from them:",
              ...unalignable.map((u) => `  ${u}`),
            ]
          : []),
      ],
      prints,
    },
    null,
    2,
  )}\n`,
);

// ----------------------------------------------------- the print meco ships

const references = prints.filter((p) => p.reference);
if (references.length === 0) {
  throw new Error("No detection in expected.json is marked `reference`, so meco has nothing to ship.");
}
for (const r of references) {
  if (r.is !== "not-a-face") {
    throw new Error(`${r.file}#${String(r.index)} is marked reference but classified "${r.is}".`);
  }
}

/** 512 floats, eight to a line, so a diff of one of them is readable. */
const asRows = (print: number[]) =>
  Array.from({ length: Math.ceil(print.length / 8) }, (_, i) =>
    `      ${print.slice(i * 8, i * 8 + 8).join(", ")},`,
  ).join("\n");

const body = references
  .map(
    (r) => `  {
    name: ${JSON.stringify(`${r.file}#${String(r.index)}`)},
    what: ${JSON.stringify(r.label)},
    print: [
${asRows(r.print)}
    ],
  },`,
  )
  .join("\n");

await writeFile(
  `${SRC}not-a-face-prints.ts`,
  `/**
 * The Not-a-Face Prints meco ships. Generated — do not edit by hand.
 *
 * Written by \`packages/faces/scripts/kart-dump.ts\` from the detections marked
 * \`reference\` in \`fixtures/karts/expected.json\`, using the same EdgeFace export
 * that computes every other Face Print. Regenerate with
 * \`pnpm --filter meco-faces dump:karts\`; \`pnpm test:embed\` fails if these
 * numbers ever stop agreeing with the model, which is what stops a swapped
 * embedder from silently turning the rule off.
 *
 * The rule that reads them, and the measurement behind its threshold, live
 * beside \`MATCH_THRESHOLD\` in \`./people.js\` — they are the same decision about
 * the same numbers, so they are not in a module of their own.
 */

/** One committed print of a thing that is not a face. */
export interface NotAFacePrint {
  /** Which fixture detection this is, so the number can be traced back. */
  name: string;
  /** What a human saw there, for a refusal message to be able to say it. */
  what: string;
  /** 512 floats on the unit sphere, like any other Face Print. */
  print: readonly number[];
}

export const NOT_A_FACE_PRINTS: readonly NotAFacePrint[] = [
${body}
] as const;
`,
);

console.log(`wrote detected.json      (${String(Object.keys(detections).length)} photographs)`);
console.log(`wrote face-prints.json   (${String(prints.length)} prints)`);
for (const u of unalignable) console.log(`  no print: ${u}`);
console.log(`wrote src/not-a-face-prints.ts (${String(references.length)} reference)`);
for (const r of references) console.log(`  ${r.file}#${String(r.index)} — ${r.label}`);
