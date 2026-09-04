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
 * when the alignment changes, then re-run the export so the reference
 * embeddings describe the new squares.
 *
 * ```
 * pnpm --filter meco-faces dump:aligned
 * .temp/edgeface-venv/bin/python packages/faces/scripts/export-edgeface.py
 * ```
 *
 * The export is not an npm script because it needs a Python that PyTorch has
 * wheels for, built by hand — see the header of `export-edgeface.py`.
 */
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { ALIGNED_SIZE, alignFace } from "../src/align.js";
import { detectFaces } from "../src/detect.js";
import type { Box, Landmarks } from "../src/yunet.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/faces/", import.meta.url));

interface Expected {
  images: { file: string; faces: { label: string; person?: string; box: Box }[] }[];
}

const expected = JSON.parse(await readFile(`${FIXTURES}expected.json`, "utf8")) as Expected;

await mkdir(`${FIXTURES}aligned/`, { recursive: true });

for (const image of expected.images) {
  if (image.faces.length === 0) continue;

  const bytes = await readFile(`${FIXTURES}${image.file}`);
  const { faces, width, height } = await detectFaces(bytes);
  if (faces.length !== image.faces.length) {
    throw new Error(
      `${image.file}: detect found ${String(faces.length)} faces but ${String(image.faces.length)} are marked. ` +
        `Run the detect test first — the fixtures disagree with the detector.`,
    );
  }

  // Both lists go left to right so they can simply be zipped. The hand-marked
  // boxes are within 3 % of the detected ones and no two faces in any fixture
  // are that close in x, so the two orders cannot disagree.
  const marked = [...image.faces].sort((a, b) => a.box.x - b.box.x);
  const found = [...faces].sort((a, b) => a.box.x - b.box.x);

  const upright = await sharp(bytes).rotate().removeAlpha().raw().toBuffer({
    resolveWithObject: true,
  });

  for (const [i, face] of found.entries()) {
    const inPixels = Object.fromEntries(
      Object.entries(face.landmarks).map(([name, p]) => [
        name,
        { x: p.x * width, y: p.y * height },
      ]),
    ) as unknown as Landmarks;

    const square = await alignFace(
      { data: upright.data, width: upright.info.width, height: upright.info.height },
      inPixels,
    );
    const name =
      `${image.file.replace(/\.[a-z]+$/, "")}-${marked[i]!.label.replace(/\s+/g, "-")}.png`;
    await sharp(square, { raw: { width: ALIGNED_SIZE, height: ALIGNED_SIZE, channels: 3 } })
      .png({ compressionLevel: 9 })
      .toFile(`${FIXTURES}aligned/${name}`);
    console.log(`wrote aligned/${name}  (person ${marked[i]!.person ?? "?"})`);
  }
}
