/**
 * Write the Face Print of every fixture face out to `fixtures/faces/face-prints.json`.
 *
 * meco calibrates its match threshold on these numbers, and meco cannot compute
 * them: matching lives in meco, the embedder lives here, and the whole point of
 * ADR-0002 is that meco's package does not carry ONNX Runtime. So the prints are
 * committed, like the aligned squares beside them, and meco's
 * `scripts/match-calibration.ts` reads a file rather than loading a model.
 *
 * Each entry also carries the person letter from `expected.json`, which is what
 * makes a sweep possible at all: without knowing which two faces are the same
 * human, a list of cosines says nothing about a threshold.
 *
 * The file is not evidence on its own — a stale one would calibrate a threshold
 * against a model nobody runs. `pnpm test:embed` re-embeds every fixture face
 * and refuses to pass unless this file still matches, which is the same
 * arrangement that keeps `aligned/` current.
 *
 * Re-run with `pnpm --filter meco-faces dump:prints` whenever the fixtures, the
 * alignment or the model change.
 */
import { readFile, writeFile } from "node:fs/promises";

import { embedFaces } from "../src/embed.js";
import { FIXTURES, readFixtureFaces } from "./fixture-faces.js";

/** One fixture face, named the way `aligned/` names it. */
export interface FixturePrint {
  /** The aligned square's filename, so this file and `aligned/` agree on names. */
  name: string;
  file: string;
  label: string;
  /** Two faces sharing a letter are the same human. See `expected.json`. */
  person: string;
  /** 512 floats on the unit sphere. */
  print: number[];
}

const fixtures = await readFixtureFaces();
const prints: FixturePrint[] = [];

for (const image of fixtures) {
  const embedded = await embedFaces(
    await readFile(`${FIXTURES}${image.file}`),
    image.faces.map(({ face }) => face),
  );
  for (const [i, { name, person, marked }] of image.faces.entries()) {
    prints.push({ name, file: image.file, label: marked.label, person, print: embedded[i]! });
  }
}

await writeFile(
  `${FIXTURES}face-prints.json`,
  `${JSON.stringify(
    {
      $comment: [
        "The Face Print of every fixture face, from meco-faces' own ONNX path,",
        "written by packages/faces/scripts/print-dump.ts. meco's",
        "scripts/match-calibration.ts sweeps its match threshold over these, so",
        "that the calibration needs no model and no network.",
        "person is which human the face belongs to: two faces sharing a letter",
        "are the same human. It comes from expected.json.",
        "Kept current by `pnpm test:embed`, which re-embeds every fixture face",
        "and fails if this file no longer matches. Re-write it with",
        "`pnpm --filter meco-faces dump:prints`.",
      ],
      prints,
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote face-prints.json  (${String(prints.length)} faces)`);
for (const p of prints) console.log(`  ${p.name}  person ${p.person}`);
