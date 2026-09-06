// The committed fixture detections and prints, lifted into contracts
// Annotations keyed by the sha256 of the photograph's own bytes, so the models
// wire can be faked by hash and no ONNX enters the gateway graph (#88, Q13).
// Which print lands on which face is not the point here; identify's fixtures
// pair them by box. What matters is that every face carries a legal Face Print
// the wire check has to strip.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Annotation, type ModelId, type Region } from "@meco/contracts";
import modelsCatalogue from "./fixtures/models-catalogue.json";

const FACES = fileURLToPath(new URL("../../../fixtures/faces/", import.meta.url));
const KARTS = fileURLToPath(new URL("../../../fixtures/karts/", import.meta.url));

const read = (name: string): unknown =>
  JSON.parse(readFileSync(`${FACES}${name}`, "utf8"));

/**
 * The one karting photograph the gateway tests use, and the Annotation the
 * fake models host answers for it.
 *
 * `detected.json` beside it is faces alone, and YuNet finds none here — which
 * is why this photograph exists. What frame needs is the `vehicle` Regions
 * D-FINE found, so the fixture is a whole recorded Annotation rather than
 * something assembled from the detection files: assembling one would put
 * D-FINE's label-to-Kind rule in a test, where it would be a second copy of
 * the adapter's.
 *
 * A copy of `packages/frame/tests/fixtures/on-track-dark-visor.json`, re-record
 * both with `pnpm --filter @meco/frame record <models url>`. Copied because a
 * package may not import another package's tests, and the two are held together
 * by the hash check in {@link fixtureAnnotation}: a recording that is not of
 * these bytes fails every test that reads it.
 */
export const KART_FILE = "on-track-dark-visor.jpg";
const kartRecording = (): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./fixtures/on-track-dark-visor.json", import.meta.url)),
      "utf8"
    )
  );

const detected = read("detected.json") as {
  readonly images: Record<
    string,
    {
      readonly width: number;
      readonly height: number;
      readonly faces: readonly {
        readonly box: Region["box"];
        readonly score: number;
        readonly landmarks: Region["landmarks"];
      }[];
    }
  >;
};

const printed = read("face-prints.json") as {
  readonly prints: readonly { readonly file: string; readonly print: number[] }[];
};

/** The Catalogue the fake models host lists, as `{ name, version }` pairs. */
export const CATALOGUE: readonly ModelId[] = modelsCatalogue.map(
  ({ name, version }) => ({ name, version })
);

const modelNamed = (name: string): ModelId => {
  const found = CATALOGUE.find((m) => m.name === name);
  if (found === undefined) throw new Error(`no fixture Model ${name}`);
  return found;
};

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** A fixture photograph's bytes. */
export const fixtureBytes = (file: string): Uint8Array =>
  new Uint8Array(readFileSync(`${file === KART_FILE ? KARTS : FACES}${file}`));

/** Every photograph the fake hosts serve and answer for. */
export const FIXTURE_FILES: readonly string[] = [
  ...Object.keys(detected.images),
  KART_FILE,
];

/**
 * The Annotation the fake models host answers for one fixture photograph:
 * every recorded face as a face Region with a print, every Catalogue entry in
 * `producedBy`, and the hash of the file's own bytes.
 */
export function fixtureAnnotation(file: string): Annotation {
  if (file === KART_FILE) {
    const recorded = Annotation.parse(kartRecording());
    const bytes = sha256(fixtureBytes(file));
    if (recorded.hash !== bytes) {
      throw new Error(
        `the ${file} recording is of ${recorded.hash}, not of the committed bytes (${bytes})`
      );
    }
    return recorded;
  }

  const image = detected.images[file];
  if (image === undefined) throw new Error(`no recorded detection for ${file}`);
  const prints = printed.prints.filter((one) => one.file === file);
  const regions = image.faces.map((face, index) => {
    const print = prints[index % prints.length];
    return {
      id: `face-${index + 1}`,
      kind: "face",
      label: "face",
      box: face.box,
      score: face.score,
      model: modelNamed("yunet"),
      landmarks: face.landmarks,
      ...(print === undefined
        ? {}
        : { facePrint: { model: modelNamed("edgeface"), vector: print.print } }),
    };
  });
  // Parsed, not cast: the fixtures are files on disk, and the contracts schema
  // is what says they are still an Annotation.
  return Annotation.parse({
    schema: 1,
    hash: sha256(fixtureBytes(file)),
    mime: "image/jpeg",
    width: image.width,
    height: image.height,
    producedBy: CATALOGUE,
    regions,
  });
}

/** The fixture Annotation whose bytes hash to `hash`, or `null`. */
export function annotationByHash(hash: string): Annotation | null {
  const file = FIXTURE_FILES.find((one) => sha256(fixtureBytes(one)) === hash);
  return file === undefined ? null : fixtureAnnotation(file);
}
