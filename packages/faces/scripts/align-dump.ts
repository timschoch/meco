/**
 * Write the aligned 112x112 squares for every fixture face, as PNG.
 *
 * These squares are the seam between the two halves of the embed check. This
 * script produces them with the real aligner; `export-edgeface.py` reads the
 * same files and records what PyTorch makes of them; and `embed-test.ts` asserts
 * both that the aligner still produces exactly these pixels and that the ONNX
 * model agrees with the PyTorch numbers on them. Without a committed artefact in
 * the middle, "the ONNX output matches the PyTorch output" would need a Python
 * interpreter every time anyone ran the tests.
 *
 * Not part of the test run: it writes fixtures rather than checking them. Run it
 * when the alignment changes, then re-run the export so the reference Face
 * Prints describe the new squares.
 *
 * ```
 * pnpm --filter meco-faces dump:aligned
 * .temp/edgeface-venv/bin/python packages/faces/scripts/export-edgeface.py
 * ```
 *
 * The export is not an npm script because it needs a Python that PyTorch has
 * wheels for, built by hand — see the header of `export-edgeface.py`.
 */
import { mkdir } from "node:fs/promises";

import sharp from "sharp";

import { ALIGNED_SIZE, alignFace, inPixels } from "../src/align.js";
import { FIXTURES, readFixtureFaces } from "./fixture-faces.js";

await mkdir(`${FIXTURES}aligned/`, { recursive: true });

for (const image of await readFixtureFaces()) {
  for (const { name, person, face } of image.faces) {
    const square = await alignFace(
      image.upright,
      inPixels(face.landmarks, image.upright.width, image.upright.height),
    );
    await sharp(square, { raw: { width: ALIGNED_SIZE, height: ALIGNED_SIZE, channels: 3 } })
      .png({ compressionLevel: 9 })
      .toFile(`${FIXTURES}aligned/${name}`);
    console.log(`wrote aligned/${name}  (person ${person})`);
  }
}
