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
 * The one karting photograph the gateway tests use. YuNet finds no face
 * through those visors, which is why it exists: only frame's `kart` rung can
 * place a window on it.
 */
export const KART_FILE = "on-track-dark-visor.jpg";

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

/**
 * Every photograph the fake hosts serve and answer for: where its bytes are,
 * and where its Annotation comes from.
 *
 * A photograph under `fixtures/faces/` has its Annotation assembled below from
 * `detected.json` and `face-prints.json`. A photograph with a `recording` has a
 * whole Annotation on disk instead, because what frame needs from it is
 * D-FINE's `vehicle` Regions, and assembling those here would put the adapter's
 * label-to-Kind rule in a test as a second copy of itself.
 *
 * `on-track-dark-visor.json` is a copy of the recording under
 * `packages/frame/tests/fixtures/`; re-record both with
 * `pnpm --filter @meco/frame record <models url>`. Copied because a package may
 * not import another package's tests, and held to its photograph by the hash
 * check in {@link fixtureAnnotation}.
 *
 * `kart-grid-24.jpg` is not copied: its recording lives beside the photograph
 * at `fixtures/karts/annotations/`, where identify's and frame's suites read
 * it too. A recording no package owns needs no copy in any of them.
 */
const RECORDINGS = fileURLToPath(new URL("./fixtures/", import.meta.url));
const SHARED_RECORDINGS = fileURLToPath(
  new URL("../../../fixtures/karts/annotations/", import.meta.url)
);

/**
 * The grid photograph #227 is about: five karts, four race numbers read by
 * `ppocr` and one face. The only fixture here holding a `number` Region.
 */
export const KART_GRID_FILE = "kart-grid-24.jpg";

const SOURCES: Record<
  string,
  { dir: string; recording?: string; recordingDir?: string }
> = {
  ...Object.fromEntries(
    Object.keys(detected.images).map((file) => [file, { dir: FACES }])
  ),
  [KART_FILE]: { dir: KARTS, recording: "on-track-dark-visor.json" },
  [KART_GRID_FILE]: {
    dir: KARTS,
    recording: "kart-grid-24.json",
    recordingDir: SHARED_RECORDINGS,
  },
};

const sourceOf = (
  file: string
): { dir: string; recording?: string; recordingDir?: string } => {
  const found = SOURCES[file];
  if (found === undefined) throw new Error(`no fixture photograph ${file}`);
  return found;
};

/** A fixture photograph's bytes. */
export const fixtureBytes = (file: string): Uint8Array =>
  new Uint8Array(readFileSync(`${sourceOf(file).dir}${file}`));

/** Every photograph the fake hosts serve and answer for. */
export const FIXTURE_FILES: readonly string[] = Object.keys(SOURCES);

/**
 * The Annotation the fake models host answers for one fixture photograph:
 * the recording where there is one, and otherwise every recorded face as a
 * face Region with a print, every Catalogue entry in `producedBy`, and the
 * hash of the file's own bytes.
 */
export function fixtureAnnotation(file: string): Annotation {
  const { recording, recordingDir } = sourceOf(file);
  if (recording !== undefined) {
    const recorded = Annotation.parse(
      JSON.parse(
        readFileSync(`${recordingDir ?? RECORDINGS}${recording}`, "utf8")
      )
    );
    const bytes = sha256(fixtureBytes(file));
    if (recorded.hash !== bytes) {
      throw new Error(
        `the ${recording} recording is of ${recorded.hash}, not of the committed bytes of ${file} (${bytes})`
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
