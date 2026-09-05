/**
 * Re-record `fixtures/faces/detected.json` from a real detection.
 *
 * The file's own `$comment` said how to regenerate it — "POST the fixture bytes
 * to /detect and round the answer" — which is an instruction to a human, not a
 * generator. Issue #53 re-derived the fixtures at the bound `src/faces.ts`
 * applies, and every coordinate in that file immediately described pixels no
 * longer on disk. `kart-dump.ts` raises the objection this script answers: a
 * recording nobody can regenerate is a number nobody can check.
 *
 * It is a *recording*, not a claim. What guards the detector is
 * `pnpm test:detect`, which measures it against the hand-marked boxes in
 * `expected.json`. This file only exists so that meco's own tests can frame a
 * Crop on a real detection without loading ONNX Runtime.
 *
 * Which photographs are recorded is read from the existing file rather than
 * chosen here: `jezero-crater.jpg` has no faces and `astronaut-portrait-2.jpg`
 * is carried by the embed fixtures instead, and neither of those is this
 * script's decision to change.
 *
 * Re-run with `pnpm --filter meco-faces dump:detected` whenever the face
 * fixtures or the detector change.
 */
import { readFile, writeFile } from "node:fs/promises";

import { detectFaces, type Face } from "../src/detect.js";
import { FIXTURES } from "./fixture-faces.js";

interface DetectedFile {
  $comment: string[];
  images: Record<string, { width: number; height: number; faces: unknown[] }>;
}

const existing = JSON.parse(await readFile(`${FIXTURES}detected.json`, "utf8")) as DetectedFile;

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

const images: DetectedFile["images"] = {};
for (const [file, previous] of Object.entries(existing.images)) {
  const found = await detectFaces(await readFile(`${FIXTURES}${file}`));
  // A changed count is a fixture that stopped working, not a number to record.
  // `expected.json` is the human's answer and this file has to agree with it.
  if (found.faces.length !== previous.faces.length) {
    throw new Error(
      `${file}: detect found ${String(found.faces.length)} faces but the recording has ` +
        `${String(previous.faces.length)}. Check pnpm test:detect before re-recording.`,
    );
  }
  images[file] = {
    width: found.width,
    height: found.height,
    faces: found.faces.map(recordFace),
  };
  console.log(
    `${file.padEnd(26)} ${String(found.width)}x${String(found.height)}  ` +
      `${String(found.faces.length)} faces  (was ${String(previous.width)}x${String(previous.height)})`,
  );
}

await writeFile(
  `${FIXTURES}detected.json`,
  `${JSON.stringify({ $comment: existing.$comment, images }, null, 2)}\n`,
);
console.log(`\nwrote detected.json (${String(Object.keys(images).length)} photographs)`);
