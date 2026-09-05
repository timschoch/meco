/**
 * Re-record what `POST /objects` returns for every photograph in
 * `fixtures/karts/`, and the Subject Box the kart producer composes from it.
 *
 * `fixtures/karts/objects.json` was recorded once, by hand, when the kart
 * producer landed. Issue #42 then re-derived the fixtures at the bound
 * `src/faces.ts` applies to a Source Image, and every coordinate in that file
 * was suddenly a claim about pixels no longer on disk. A recording with no
 * generator is a number nobody can regenerate — the objection
 * `kart-dump.ts` raises about itself — so this is the missing half.
 *
 * What it does **not** touch is the human's half. `note` and `subjectNote` say
 * what a person saw when the boxes were rendered over the photograph, and a
 * script cannot re-derive that. Both are read from the existing file and written
 * back unchanged; a photograph with no entry yet is refused rather than given an
 * empty note, because a fixture nobody has looked at is not a fixture.
 *
 * The scores and boxes move a little on every re-record — the model is
 * deterministic but the JPEG it is given is not the same JPEG. That is what
 * `tolerance` in the file is for, and why the class *set* rather than the exact
 * geometry is the claim `objects-test.ts` makes.
 *
 * Re-run with `pnpm --filter meco-faces dump:objects` whenever the kart
 * fixtures or the object model change, then **look at the rendered boxes** and
 * correct the notes before committing.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { kartSubjectBox } from "../../../src/crop.js";
import { detectObjects } from "../src/objects.js";

const KARTS = fileURLToPath(new URL("../../../fixtures/karts/", import.meta.url));

interface ObjectRecord {
  label: string;
  score: number;
  box: { x: number; y: number; width: number; height: number };
}

interface ImageRecord {
  file: string;
  width: number;
  height: number;
  note: string;
  objects: ObjectRecord[];
  subject: { x: number; y: number; width: number; height: number } | null;
  subjectNote: string;
}

interface ObjectsFile {
  $comment: string[];
  tolerance: number;
  images: ImageRecord[];
}

const existing = JSON.parse(await readFile(`${KARTS}objects.json`, "utf8")) as ObjectsFile;
const round4 = (n: number) => +n.toFixed(4);

const images: ImageRecord[] = [];
for (const previous of existing.images) {
  const bytes = await readFile(`${KARTS}${previous.file}`);
  const found = await detectObjects(bytes);

  images.push({
    file: previous.file,
    width: found.width,
    height: found.height,
    // The human's half, carried over rather than regenerated.
    note: previous.note,
    objects: found.objects.map((o) => ({
      label: o.label,
      score: round4(o.score),
      box: {
        x: round4(o.box.x),
        y: round4(o.box.y),
        width: round4(o.box.width),
        height: round4(o.box.height),
      },
    })),
    // The composed Subject Box, from meco's own rule rather than a copy of it.
    // `kartSubjectBox` is pure geometry with no ONNX in its import graph, so
    // reading it here at dev time adds nothing to either shipped image — and a
    // second implementation is the one thing this file must not contain.
    subject: (() => {
      const box = kartSubjectBox(found.objects);
      // Only the geometry is recorded. `producer`, `priority` and `keep` are the
      // producer's own answer and belong in `src/crop.ts`, not in a fixture.
      return box === null
        ? null
        : {
            x: round4(box.x),
            y: round4(box.y),
            width: round4(box.width),
            height: round4(box.height),
          };
    })(),
    subjectNote: previous.subjectNote,
  });
  console.log(
    `${previous.file.padEnd(28)} ${String(found.width)}x${String(found.height)}  ` +
      `${String(found.objects.length)} objects  (was ${String(previous.width)}x${String(previous.height)}, ` +
      `${String(previous.objects.length)})`,
  );
}

await writeFile(
  `${KARTS}objects.json`,
  `${JSON.stringify({ $comment: existing.$comment, tolerance: existing.tolerance, images }, null, 2)}\n`,
);
console.log(`\nwrote objects.json (${String(images.length)} photographs)`);
