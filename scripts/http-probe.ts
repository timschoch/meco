/**
 * Drive the meco HTTP API in-process and check what comes back.
 *
 * The solver test proves the arithmetic; this proves the whole crop path — the
 * request schema, the producers reading a real photograph, sharp cutting the
 * window, storage filing it, and the Gallery finding it again. Nothing here
 * listens on a port or reaches the network: `createApp` hands back a fetch
 * handler, Storage writes to a temp directory that is deleted at the end, and
 * the Source Image travels as a `data:` URL, so the run is the same everywhere.
 *
 * Same shape as `scripts/mcp-probe.ts`: one line per check, non-zero exit when
 * any of them failed.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import sharp from "sharp";

import { createApp } from "../src/app.js";
import { CROP_PRODUCERS, solveCrop } from "../src/crop-solver.js";
import { faceSubjectBoxes } from "../src/crop.js";
import { facesInFrame } from "../src/face-blur.js";
import { FACES_URL, type Detection } from "../src/faces.js";
import { LocalStorage } from "../src/storage.js";

const problems: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok    " : "FAIL  "}${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) problems.push(name);
}

/**
 * The probe owns its environment rather than inheriting it: a token set in the
 * shell would otherwise turn every call into a 401, and pinning one here means
 * the auth the container runs with is on the path being tested.
 */
const TOKEN = "probe-token";
process.env.MECO_TOKEN = TOKEN;

/**
 * No face service until the faces section switches one on.
 *
 * Face detection is opt-in per deployment, and the crops below are the ones that
 * were framed without it — leaving it unset here is what keeps them a test of
 * the producers they are about, and proves in passing that a meco with no
 * `FACES_URL` behaves exactly as it did before there was one.
 */
delete process.env[FACES_URL];

const root = await mkdtemp(join(tmpdir(), "meco-http-"));
const storage = new LocalStorage(root, "http://local");
const app = createApp(storage);

// ------------------------------------------------------------------ fixtures

/** A photograph with somewhere obvious to look, so saliency has an answer. */
async function photo(width: number, height: number): Promise<string> {
  const subject = await sharp({
    create: {
      width: Math.round(width / 8),
      height: Math.round(width / 8),
      channels: 3,
      background: { r: 236, g: 198, b: 168 },
    },
  })
    .png()
    .toBuffer();

  const data = await sharp({
    create: { width, height, channels: 3, background: { r: 22, g: 32, b: 44 } },
  })
    .composite([
      { input: subject, left: Math.round(width * 0.62), top: Math.round(height * 0.2) },
    ])
    .jpeg({ quality: 80 })
    .toBuffer();

  return `data:image/jpeg;base64,${data.toString("base64")}`;
}

const LANDSCAPE = await photo(1600, 1000);
/** Exactly 9:16, so a 9:16 request needs no crop and sharp reports no point. */
const EXACT_9_16 = await photo(540, 960);

// ------------------------------------------------------------------- driving

interface Json {
  [key: string]: unknown;
}

async function post(path: string, body: Json): Promise<{ status: number; json: Json }> {
  const res = await app.fetch(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-auth-token": TOKEN },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Json };
}

async function get(path: string): Promise<{ status: number; json: Json }> {
  const res = await app.fetch(
    new Request(`http://local${path}`, { headers: { "x-auth-token": TOKEN } }),
  );
  return { status: res.status, json: (await res.json()) as Json };
}

/** The size the stored bytes really have, not the size the response claims. */
async function storedSize(key: unknown): Promise<string> {
  const meta = await sharp(await readFile(join(root, String(key)))).metadata();
  return `${String(meta.width)}x${String(meta.height)}`;
}

/**
 * The share of an image that is the bright block the fixture calls its Subject.
 *
 * This is the only check here that looks at pixels, and it is the one that
 * catches a producer reading a coordinate in the wrong space: such a Crop still
 * returns 200 at the right size and still names a producer, and simply frames
 * empty background. Nothing but the pixels says so.
 */
async function subjectShare(image: Buffer): Promise<number> {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bright = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i]! > 200 && data[i + 1]! > 160) bright++;
  }
  return bright / (info.width * info.height);
}

/** What the Subject is worth in the whole photograph, before any cropping. */
const SUBJECT_IN_SOURCE = await subjectShare(
  Buffer.from(LANDSCAPE.slice("data:image/jpeg;base64,".length), "base64"),
);

// --------------------------------------------------------------------- crops

console.log("crop");

interface CropCase {
  label: string;
  body: Json;
  resolvedBy: string;
  anchor?: string;
  /** A producer that looks for the Subject must not frame the background. */
  keepsSubject?: boolean;
  /** What the response must say about the Subject Area, when one was asked for. */
  subjectArea?: boolean;
}

const CASES: CropCase[] = [
  {
    label: "a Crop Anchor",
    body: { source: LANDSCAPE, width: 1080, height: 1350, anchor: "top" },
    resolvedBy: "anchor",
    anchor: "top",
  },
  {
    label: "attention",
    body: { source: LANDSCAPE, width: 1080, height: 1920, strategy: "attention" },
    resolvedBy: "saliency",
    keepsSubject: true,
  },
  {
    label: "entropy",
    body: { source: LANDSCAPE, width: 1080, height: 1080, strategy: "entropy" },
    resolvedBy: "saliency",
    keepsSubject: true,
  },
  {
    label: "neither",
    body: { source: LANDSCAPE, width: 1200, height: 627 },
    resolvedBy: "centre",
  },
  {
    label: "png at a wide shape",
    body: { source: LANDSCAPE, width: 1920, height: 1080, format: "png", anchor: "bottom-right" },
    resolvedBy: "anchor",
    anchor: "bottom-right",
  },
  // An exact-aspect request leaves libvips nothing to crop, so no saliency point
  // comes back and the Crop Anchor has to answer instead.
  {
    label: "attention at a fourth shape",
    body: { source: LANDSCAPE, width: 1080, height: 1350, strategy: "attention" },
    resolvedBy: "saliency",
    keepsSubject: true,
  },
  {
    label: "attention at a wide shape",
    body: { source: LANDSCAPE, width: 1920, height: 1080, strategy: "attention" },
    resolvedBy: "saliency",
    keepsSubject: true,
  },
  {
    label: "attention with nothing to crop",
    body: { source: EXACT_9_16, width: 1080, height: 1920, strategy: "attention", anchor: "left" },
    resolvedBy: "anchor",
    anchor: "left",
  },
  // A Subject Area the framing can reach. The Crop Anchor pins the point, so the
  // only thing under test is whether the area moved it and said that it had.
  {
    label: "a Subject Area it can hit",
    body: {
      source: LANDSCAPE,
      width: 1080,
      height: 1350,
      anchor: "center",
      subjectArea: { x: 0.4, y: 0.35, width: 0.3, height: 0.3 },
    },
    resolvedBy: "anchor",
    anchor: "center",
    subjectArea: true,
  },
  // The same picture, an area up in the corner. A 9:16 window of a landscape
  // photograph is already full height, so nothing can lift the centre of the
  // picture into the top fifth of the frame — and the answer has to admit it.
  {
    label: "a Subject Area it cannot hit",
    body: {
      source: LANDSCAPE,
      width: 1080,
      height: 1920,
      anchor: "center",
      subjectArea: { x: 0.05, y: 0.05, width: 0.2, height: 0.2 },
    },
    resolvedBy: "anchor",
    anchor: "center",
    subjectArea: false,
  },
];

/**
 * Every distinct Crop that made it into storage.
 *
 * A set rather than a count, because storage is content-addressed: two requests
 * that frame the same pixels file one object, and the Gallery is right to list
 * it once.
 */
const cropKeys = new Set<string>();

for (const one of CASES) {
  const { status, json } = await post("/v1/crop", one.body);
  const wanted = `${String(one.body.width)}x${String(one.body.height)}`;
  check(`${one.label} returned 200`, status === 200, JSON.stringify(json).slice(0, 200));
  if (status !== 200) continue;
  cropKeys.add(String(json.key));
  check(
    `${one.label} returned the size asked for`,
    `${String(json.width)}x${String(json.height)}` === wanted,
    `wanted ${wanted}`,
  );
  check(
    `${one.label} stored an image of that size`,
    (await storedSize(json.key)) === wanted,
    await storedSize(json.key),
  );
  check(
    `${one.label} named the producer that framed it`,
    json.resolvedBy === one.resolvedBy,
    `resolvedBy=${String(json.resolvedBy)}`,
  );
  check(
    `${one.label} named a producer that exists`,
    CROP_PRODUCERS.includes(json.resolvedBy as never),
  );
  check(
    `${one.label} reported whether the Subject was held`,
    typeof json.satisfied === "boolean",
    `satisfied=${String(json.satisfied)}`,
  );
  if (one.anchor) {
    check(`${one.label} echoed the Crop Anchor`, json.anchor === one.anchor);
  }
  check(
    one.subjectArea === undefined
      ? `${one.label} claimed nothing about a Subject Area it was not given`
      : `${one.label} reported the Subject Area as ${String(one.subjectArea)}`,
    json.subjectAreaSatisfied === one.subjectArea,
    `subjectAreaSatisfied=${String(json.subjectAreaSatisfied)}`,
  );
  if (one.keepsSubject) {
    // At least as prominent as in the whole photograph: a Crop that went looking
    // for the Subject must end up with more of it, never less.
    const share = await subjectShare(await readFile(join(root, String(json.key))));
    check(
      `${one.label} framed the Subject rather than the background`,
      share >= SUBJECT_IN_SOURCE,
      `${(share * 100).toFixed(2)}% of the Crop, ${(SUBJECT_IN_SOURCE * 100).toFixed(2)}% of the Source Image`,
    );
  }
}

const rejected = await post("/v1/crop", { source: LANDSCAPE, width: 0, height: 100 });
check("a Crop of no size is refused", rejected.status === 400, String(rejected.status));

const dead = await post("/v1/crop", { source: "not-a-url", width: 100, height: 100 });
check("a source that is not a URL is refused", dead.status === 400, String(dead.status));

// ------------------------------------------------------------- Subject Area

console.log("\nsubject area");

/**
 * The same Crop with and without an area. Storage is content-addressed, so a
 * different key is a different picture — which is the whole claim, made in one
 * comparison rather than by reading pixels back.
 */
const WITHOUT = { source: LANDSCAPE, width: 1080, height: 1350, anchor: "center" };
const plain = await post("/v1/crop", WITHOUT);
const aimed = await post("/v1/crop", {
  ...WITHOUT,
  subjectArea: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
});
cropKeys.add(String(plain.json.key));
cropKeys.add(String(aimed.json.key));
check(
  "a Subject Area changed the pixels the Crop kept",
  plain.json.key !== aimed.json.key,
  `${String(plain.json.key)} vs ${String(aimed.json.key)}`,
);
check(
  "the Crop with no Subject Area still frames as it always did",
  plain.json.resolvedBy === "anchor" && plain.json.subjectAreaSatisfied === undefined,
  JSON.stringify(plain.json).slice(0, 160),
);

const OUT_OF_RANGE: Json[] = [
  { label: "x below zero", subjectArea: { x: -0.1, y: 0.1, width: 0.4, height: 0.4 } },
  { label: "height above one", subjectArea: { x: 0.1, y: 0.1, width: 0.4, height: 1.4 } },
  { label: "a width of zero", subjectArea: { x: 0.1, y: 0.1, width: 0, height: 0.4 } },
  { label: "a rectangle off the right edge", subjectArea: { x: 0.8, y: 0.1, width: 0.4, height: 0.4 } },
  { label: "a missing side", subjectArea: { x: 0.1, y: 0.1, width: 0.4 } },
];

for (const one of OUT_OF_RANGE) {
  const { status } = await post("/v1/crop", {
    source: LANDSCAPE,
    width: 1080,
    height: 1350,
    subjectArea: one.subjectArea,
  });
  check(`a Subject Area with ${String(one.label)} is refused`, status === 400, String(status));
}

// --------------------------------------------------------------------- faces

console.log("\nfaces");

/**
 * A stand-in for meco-faces, on a real socket.
 *
 * `FACES_URL` is meco's only injection point for the face service, so a stand-in
 * that listens on a port is reached by exactly the code path the deployed
 * service is — the client, the token header, the parsing of the answer. Nothing
 * is stubbed inside meco.
 *
 * It counts what it is asked, which is the only way to prove the claim that
 * matters about the Annotation cache: not that the second answer is the same,
 * but that the second answer cost nothing.
 *
 * What it answers with is recorded from the real detector — see
 * `fixtures/faces/detected.json` — so the framing under test is the framing a
 * real photograph gets, without ONNX Runtime in this process.
 */
const fixtures = (path: string) =>
  fileURLToPath(new URL(`../fixtures/faces/${path}`, import.meta.url));

const recorded = JSON.parse(await readFile(fixtures("detected.json"), "utf8")) as {
  images: Record<string, Detection>;
};

/**
 * Hashed here rather than with `sourceHash` from `src/annotations.ts`.
 *
 * The claim below is that meco files an Annotation under the SHA-256 of the
 * Source Image bytes. Computing the expected key with the very function that
 * computes the real one would make that claim true by construction.
 */
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Recorded detections, keyed by the hash of the photograph they belong to. */
const canned = new Map<string, Detection>();
/** One entry per request the stand-in was asked to serve. */
const detectCalls: string[] = [];

const facesService = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    void (async () => {
      const body = Buffer.concat(chunks);
      detectCalls.push(sha(body));
      const known = canned.get(sha(body));
      // An image nobody recorded is a photograph with no faces in it, answered
      // the way meco-faces would answer one: its real size, and an empty list.
      const answer = known ?? { ...(await sharp(body).metadata()), faces: [] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ width: answer.width, height: answer.height, faces: answer.faces }),
      );
    })();
  });
});

await new Promise<void>((resolve) => facesService.listen(0, "127.0.0.1", resolve));
const facesPort = (facesService.address() as { port: number }).port;
process.env[FACES_URL] = `http://127.0.0.1:${String(facesPort)}`;

/** One of the fixture photographs, as the `data:` URL a Crop takes. */
async function fixturePhoto(name: string): Promise<{ url: string; hash: string }> {
  const bytes = await readFile(fixtures(name));
  return { url: `data:image/jpeg;base64,${bytes.toString("base64")}`, hash: sha(bytes) };
}

const PORTRAIT = await fixturePhoto("astronaut-portrait.jpg");
const GROUP = await fixturePhoto("artemis-2-crew.jpg");
canned.set(PORTRAIT.hash, recorded.images["astronaut-portrait.jpg"]!);
canned.set(GROUP.hash, recorded.images["artemis-2-crew.jpg"]!);

for (const shape of [
  { label: "9:16", width: 1080, height: 1920 },
  { label: "4:5", width: 1080, height: 1350 },
  { label: "1:1", width: 1080, height: 1080 },
]) {
  const { status, json } = await post("/v1/crop", {
    source: PORTRAIT.url,
    width: shape.width,
    height: shape.height,
  });
  cropKeys.add(String(json.key));
  const wanted = `${String(shape.width)}x${String(shape.height)}`;
  check(
    `a portrait at ${shape.label} was framed on the face`,
    status === 200 && json.resolvedBy === "face" && json.satisfied === true,
    `${String(status)} resolvedBy=${String(json.resolvedBy)} satisfied=${String(json.satisfied)}`,
  );
  check(
    `a portrait at ${shape.label} stored an image of the size asked for`,
    (await storedSize(json.key)) === wanted,
    await storedSize(json.key),
  );
}

/**
 * The cache, which is the whole reason an Annotation is stored at all.
 *
 * Three shapes of the same photograph have just been cropped, and the group
 * photograph has not been seen at all. One detection for the portrait, one for
 * the group, and nothing for the two repeats.
 */
const afterPortrait = detectCalls.length;
check(
  "three Crops of one photograph cost one detection",
  afterPortrait === 1,
  `${String(afterPortrait)} calls to the face service`,
);

const groupCrop = await post("/v1/crop", { source: GROUP.url, width: 1920, height: 1080 });
cropKeys.add(String(groupCrop.json.key));
check(
  "a group photograph is framed on a face too",
  groupCrop.status === 200 && groupCrop.json.resolvedBy === "face",
  `${String(groupCrop.status)} resolvedBy=${String(groupCrop.json.resolvedBy)}`,
);
check(
  "a photograph never seen before does cost a detection",
  detectCalls.length === afterPortrait + 1,
  `${String(detectCalls.length)} calls in total`,
);

const again = await post("/v1/crop", { source: PORTRAIT.url, width: 1080, height: 1920 });
check(
  "a second request for the same Source Image bytes makes no call at all",
  detectCalls.length === afterPortrait + 1 && again.status === 200,
  `${String(detectCalls.length)} calls, still ${String(afterPortrait + 1)}`,
);
check(
  "and it returns the same Crop it did the first time",
  cropKeys.has(String(again.json.key)),
  String(again.json.key),
);

/**
 * The Annotation itself, stored in the IPTC Image Region shape.
 *
 * Read back off disk rather than out of the response, because where it is filed
 * and what is in it are two separate promises and only the file keeps both.
 */
const annotationKey = `annotations/${PORTRAIT.hash}.json`;
const annotation = JSON.parse(
  await readFile(join(root, annotationKey), "utf8"),
) as {
  source: { hash: string; width: number; height: number };
  ImageRegion: {
    RegionId: string;
    RegionBoundary: { RbShape: string; RbUnit: string; RbW: number };
    rCtype: { uri: string }[];
    "meco:producer": string;
  }[];
};
check(
  "the Annotation is filed under the hash of the Source Image bytes",
  annotation.source.hash === PORTRAIT.hash,
  annotationKey,
);
check(
  "it carries one machine region per detected face",
  annotation.ImageRegion.length === recorded.images["astronaut-portrait.jpg"]!.faces.length &&
    annotation.ImageRegion.every((r) => r["meco:producer"] === "yunet"),
  `${String(annotation.ImageRegion.length)} regions`,
);
check(
  "every region is an IPTC rectangle in relative units",
  annotation.ImageRegion.every(
    (r) =>
      r.RegionBoundary.RbShape === "rectangle" &&
      r.RegionBoundary.RbUnit === "relative" &&
      r.RegionBoundary.RbW > 0 &&
      r.RegionBoundary.RbW <= 1,
  ),
  JSON.stringify(annotation.ImageRegion[0]?.RegionBoundary),
);
check(
  "a face is an IPTC human region",
  annotation.ImageRegion.every((r) =>
    r.rCtype.some((c) => c.uri === "http://cv.iptc.org/newscodes/imageregiontype/human"),
  ),
);

// ------------------------------------------------------------------ Face Blur

/**
 * The mask, proven in pixels rather than by reading the count back.
 *
 * `blurred` is easy to return and easy to return wrongly, so the claim under
 * test is the one a caller actually cares about: inside every face the picture
 * changed, and outside every face not one byte did. The second half is what
 * separates an elliptical mask bounded to the faces from a blur of the whole
 * frame that happens to look right.
 *
 * PNG on both sides, because JPEG would re-quantise the untouched pixels too and
 * "byte-identical" would stop meaning anything.
 */
console.log("\nface blur");

const BLUR_SHAPE = { width: 1080, height: 1350 };
const GROUP_DETECTION = recorded.images["artemis-2-crew.jpg"]!;
const GROUP_SIZE = { width: GROUP_DETECTION.width, height: GROUP_DETECTION.height };

const sharpCrop = await post("/v1/crop", { source: GROUP.url, ...BLUR_SHAPE, format: "png" });
const blurCrop = await post("/v1/crop", {
  source: GROUP.url,
  ...BLUR_SHAPE,
  format: "png",
  blurUnknownFaces: true,
});
cropKeys.add(String(sharpCrop.json.key));
cropKeys.add(String(blurCrop.json.key));

check(
  "every face in the window was blurred, and the answer counts them",
  blurCrop.status === 200 && blurCrop.json.blurred === GROUP_DETECTION.faces.length,
  `${String(blurCrop.status)} blurred=${String(blurCrop.json.blurred)} of ${String(GROUP_DETECTION.faces.length)}`,
);
check(
  "a Crop that did not ask for Face Blur says nothing about it",
  sharpCrop.json.blurred === undefined,
  String(sharpCrop.json.blurred),
);
check(
  "Face Blur changed the picture, so it is not the same Crop",
  sharpCrop.json.key !== blurCrop.json.key,
  `${String(sharpCrop.json.key)} vs ${String(blurCrop.json.key)}`,
);

/**
 * Where the faces landed in the finished frame.
 *
 * Solved here from the recorded detection rather than read out of the response,
 * so the rectangles the pixels are checked against are derived independently of
 * the Crop that produced them.
 */
const blurWindow = solveCrop(
  faceSubjectBoxes(GROUP_DETECTION.faces),
  GROUP_SIZE,
  BLUR_SHAPE,
  {},
);
const faceRects = facesInFrame(GROUP_DETECTION.faces, GROUP_SIZE, blurWindow, BLUR_SHAPE);

const rawFrame = async (key: unknown) =>
  sharp(join(root, String(key))).raw().toBuffer({ resolveWithObject: true });
const before = await rawFrame(sharpCrop.json.key);
const after = await rawFrame(blurCrop.json.key);

check(
  "both Crops are the same frame to compare",
  before.info.width === after.info.width &&
    before.info.height === after.info.height &&
    before.info.channels === after.info.channels,
  `${String(before.info.width)}x${String(before.info.height)}x${String(before.info.channels)}`,
);

/** True where the two frames disagree, one entry per pixel. */
const changed = new Uint8Array(before.info.width * before.info.height);
for (let i = 0; i < changed.length; i++) {
  for (let c = 0; c < before.info.channels; c++) {
    if (before.data[i * before.info.channels + c] !== after.data[i * before.info.channels + c]) {
      changed[i] = 1;
      break;
    }
  }
}

/** Marked where any face box covers, so "outside" is every face at once. */
const covered = new Uint8Array(changed.length);
for (const r of faceRects) {
  for (let y = r.top; y < r.top + r.height; y++) {
    for (let x = r.left; x < r.left + r.width; x++) covered[y * before.info.width + x] = 1;
  }
}

const changedInside = faceRects.map((r) => {
  let n = 0;
  for (let y = r.top; y < r.top + r.height; y++) {
    for (let x = r.left; x < r.left + r.width; x++) n += changed[y * before.info.width + x]!;
  }
  return n / (r.width * r.height);
});
let changedOutside = 0;
for (let i = 0; i < changed.length; i++) if (changed[i] === 1 && covered[i] === 0) changedOutside++;

check(
  "one face box per blurred face",
  faceRects.length === blurCrop.json.blurred,
  `${String(faceRects.length)} rectangles, blurred=${String(blurCrop.json.blurred)}`,
);
// Half rather than all of the box: the mask is the inscribed ellipse, which is
// π/4 of the rectangle, and the corners it leaves alone are the proof of that.
check(
  "the pixels inside every face box changed",
  changedInside.length > 0 && changedInside.every((share) => share > 0.5),
  changedInside.map((s) => s.toFixed(3)).join(" "),
);
check(
  "and the corners of the box did not, so the mask is an ellipse",
  changedInside.every((share) => share < 0.95),
  changedInside.map((s) => s.toFixed(3)).join(" "),
);
check(
  "every pixel outside the face boxes is byte-identical",
  changedOutside === 0,
  `${String(changedOutside)} of ${String(changed.length)} pixels differ`,
);

/**
 * A face the window cut out is not in the picture, so it cannot have been
 * blurred. The shape is narrow enough that the solver has to sacrifice faces —
 * the check would prove nothing on a window that held them all.
 */
const NARROW = { width: 350, height: 1400 };
const narrowWindow = solveCrop(faceSubjectBoxes(GROUP_DETECTION.faces), GROUP_SIZE, NARROW, {});
const stillShowing = facesInFrame(GROUP_DETECTION.faces, GROUP_SIZE, narrowWindow, NARROW).length;
const narrowCrop = await post("/v1/crop", {
  source: GROUP.url,
  ...NARROW,
  blurUnknownFaces: true,
});
cropKeys.add(String(narrowCrop.json.key));
check(
  "the narrow shape really does leave faces out",
  stillShowing > 0 && stillShowing < GROUP_DETECTION.faces.length,
  `${String(stillShowing)} of ${String(GROUP_DETECTION.faces.length)} faces still in frame`,
);
check(
  "a face outside the solved window is not counted",
  narrowCrop.json.blurred === stillShowing,
  `blurred=${String(narrowCrop.json.blurred)}, ${String(stillShowing)} in frame`,
);

/**
 * Face Blur must not defeat the Annotation cache. It asks for nothing the
 * framing did not already ask for, so three more Crops of a photograph already
 * seen cost no detection at all.
 */
check(
  "Face Blur costs no extra detection",
  detectCalls.length === afterPortrait + 1,
  `${String(detectCalls.length)} calls, still ${String(afterPortrait + 1)}`,
);

const nothingToHide = await post("/v1/crop", {
  source: PORTRAIT.url,
  width: 1080,
  height: 1080,
  subjectArea: { x: 0.35, y: 0.1, width: 0.3, height: 0.5 },
  blurUnknownFaces: true,
});
cropKeys.add(String(nothingToHide.json.key));
check(
  "Face Blur leaves the framing alone",
  nothingToHide.status === 200 &&
    nothingToHide.json.resolvedBy === "face" &&
    nothingToHide.json.subjectAreaSatisfied === true &&
    nothingToHide.json.blurred === 1,
  `${String(nothingToHide.status)} resolvedBy=${String(nothingToHide.json.resolvedBy)}` +
    ` blurred=${String(nothingToHide.json.blurred)}`,
);

// --------------------------------------------------------- find subjects

/**
 * `/v1/subjects` and the `find_subjects` MCP tool have to be the same answer,
 * because the console draws its overlay from one and a calling agent reads the
 * other. Driven through the app's own `/mcp` route, so this is the transport a
 * real client uses and not a direct call to the handler.
 */
const subjects = await post("/v1/subjects", { source: PORTRAIT.url });
check(
  "find subjects answers with the Annotation",
  subjects.status === 200 &&
    (subjects.json.ImageRegion as unknown[]).length === annotation.ImageRegion.length,
  `${String(subjects.status)} ${JSON.stringify(subjects.json).slice(0, 120)}`,
);
check(
  "and it too was served from the cache",
  detectCalls.length === afterPortrait + 1,
  `${String(detectCalls.length)} calls`,
);

const mcpCall = await app.fetch(
  new Request("http://local/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "find_subjects",
      "x-auth-token": TOKEN,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "find_subjects",
        arguments: { source: PORTRAIT.url },
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          [CLIENT_INFO_META_KEY]: { name: "http-probe", version: "0" },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  }),
);
const mcpText = await mcpCall.text();
// The SDK answers as JSON or as a one-event SSE stream; which is its business.
const mcpPayload = JSON.parse(
  mcpText
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("") || mcpText,
) as { result?: { content?: { text: string }[] } };
const mcpAnnotation = mcpPayload.result?.content?.[0]?.text ?? "";
check(
  "the MCP tool returns the same Annotation as the route",
  mcpAnnotation !== "" &&
    JSON.stringify(JSON.parse(mcpAnnotation)) === JSON.stringify(subjects.json),
  mcpAnnotation.slice(0, 160),
);

// --------------------------------------------- what a face makes reachable

/**
 * The refusal a Subject Area could not produce until now.
 *
 * Every producer before the face yields a bare point, and a point has no size to
 * scale up — so the zoom derived from a Subject Area was always null and the
 * Source Image was never measured against it. A face is the first Subject with a
 * width, which makes "this photograph is too small" a thing a request can
 * actually be told. It has to arrive as a 400 naming both sizes, not as a Crop
 * that quietly framed something else.
 */
const tooSmall = await post("/v1/crop", {
  source: PORTRAIT.url,
  width: 1080,
  height: 1080,
  subjectArea: { x: 0.4, y: 0.4, width: 0.05, height: 0.05 },
});
const tooSmallMessage = String(tooSmall.json.error ?? "");
check(
  "a Source Image too small for the Subject Area is refused over the wire",
  tooSmall.status === 400,
  `${String(tooSmall.status)} ${tooSmallMessage.slice(0, 120)}`,
);
check(
  "the refusal names the window it needed and the one that fits",
  tooSmallMessage.includes("7877x7877") && tooSmallMessage.includes("1120x1120"),
  tooSmallMessage,
);

/**
 * A face is also the first producer that can satisfy a Subject Area at all, so
 * the flag stops being a claim only the solver test can check.
 */
const filled = await post("/v1/crop", {
  source: PORTRAIT.url,
  width: 1080,
  height: 1080,
  subjectArea: { x: 0.35, y: 0.1, width: 0.3, height: 0.5 },
});
cropKeys.add(String(filled.json.key));
check(
  "a face fills a Subject Area and the answer says so",
  filled.status === 200 &&
    filled.json.resolvedBy === "face" &&
    filled.json.subjectAreaSatisfied === true,
  `${String(filled.status)} resolvedBy=${String(filled.json.resolvedBy)}` +
    ` subjectAreaSatisfied=${String(filled.json.subjectAreaSatisfied)}`,
);

// -------------------------------------- what the caller asked for, with faces

/**
 * A Crop Anchor and a strategy have to go on working once faces are switched on.
 *
 * They are not overridden so much as outranked: `PRIORITY` in `src/crop.ts` puts
 * a face above both, which is the order parent issue #5 story 9 asks for — a
 * Crop with no face falls back to the busiest region, then to the Crop Anchor,
 * then to centre. So the pair of claims is that a face wins when there is one,
 * and that the caller's own instruction still decides when there is not. The
 * third fixture is a photograph of Mars, which is the honest way to have no face
 * in the picture rather than switching the service off.
 */
const FACELESS = await fixturePhoto("jezero-crater.jpg");

const anchoredWithFace = await post("/v1/crop", {
  source: PORTRAIT.url,
  width: 1080,
  height: 1350,
  anchor: "top",
});
cropKeys.add(String(anchoredWithFace.json.key));
check(
  "a face outranks the Crop Anchor the caller named",
  anchoredWithFace.json.resolvedBy === "face",
  `resolvedBy=${String(anchoredWithFace.json.resolvedBy)}`,
);
check(
  "and the answer does not claim the anchor decided",
  anchoredWithFace.json.anchor === undefined,
  `anchor=${String(anchoredWithFace.json.anchor)}`,
);

const anchoredNoFace = await post("/v1/crop", {
  source: FACELESS.url,
  width: 1080,
  height: 1350,
  anchor: "top",
});
cropKeys.add(String(anchoredNoFace.json.key));
check(
  "a photograph with no face still obeys the Crop Anchor",
  anchoredNoFace.status === 200 &&
    anchoredNoFace.json.resolvedBy === "anchor" &&
    anchoredNoFace.json.anchor === "top",
  `${String(anchoredNoFace.status)} resolvedBy=${String(anchoredNoFace.json.resolvedBy)}`,
);

const salientNoFace = await post("/v1/crop", {
  source: FACELESS.url,
  width: 1080,
  height: 1920,
  strategy: "attention",
});
cropKeys.add(String(salientNoFace.json.key));
check(
  "a photograph with no face still lets the picture decide",
  salientNoFace.status === 200 && salientNoFace.json.resolvedBy === "saliency",
  `resolvedBy=${String(salientNoFace.json.resolvedBy)}`,
);

/**
 * With no face, no anchor and no strategy the answer is still `centre`.
 *
 * Pinned rather than approved. Story 9 of parent issue #5 asks for the busiest
 * region *before* the Crop Anchor, which would make this `saliency`; the
 * saliency producer has been gated behind an explicit `strategy` since it
 * shipped, and ungating it changes a Crop nobody asked to change. Recorded on
 * #11 as a question for the owner — this check is here so that the answer, when
 * it comes, has to be a deliberate edit.
 */
const bareNoFace = await post("/v1/crop", { source: FACELESS.url, width: 1200, height: 627 });
cropKeys.add(String(bareNoFace.json.key));
check(
  "with nothing asked for and no face, the centre still decides",
  bareNoFace.json.resolvedBy === "centre",
  `resolvedBy=${String(bareNoFace.json.resolvedBy)}`,
);

/**
 * Face Blur on a photograph with nobody in it. It reports zero rather than
 * staying quiet, because a caller who asked to anonymise a picture has to be
 * able to tell "there was no face here" from "the option did nothing". It lives
 * with the other faceless claims rather than up in the Face Blur section because
 * cropping Mars is itself a detection, and that section is counting them.
 */
const blurredNobody = await post("/v1/crop", {
  source: FACELESS.url,
  width: 1080,
  height: 1350,
  anchor: "center",
  blurUnknownFaces: true,
});
cropKeys.add(String(blurredNobody.json.key));
check(
  "a photograph with no face in it reports zero blurred, not nothing",
  blurredNobody.status === 200 && blurredNobody.json.blurred === 0,
  `${String(blurredNobody.status)} blurred=${String(blurredNobody.json.blurred)}`,
);

// ------------------------------------------------------ a face service down

/**
 * Pointed at a port nothing is listening on, which is what "down" is.
 *
 * A Crop must not fail because the face service did: it has other producers, and
 * a photograph framed on saliency is a worse Crop than one framed on a face but a
 * far better answer than a 500. What it must not do is stay quiet about it.
 */
process.env[FACES_URL] = "http://127.0.0.1:1";

const degraded = await post("/v1/crop", {
  source: LANDSCAPE,
  width: 1080,
  height: 1920,
  strategy: "attention",
});
cropKeys.add(String(degraded.json.key));
const warnings = (degraded.json.warnings ?? []) as string[];
check(
  "a Crop still succeeds when the face service is down",
  degraded.status === 200 && degraded.json.resolvedBy === "saliency",
  `${String(degraded.status)} resolvedBy=${String(degraded.json.resolvedBy)}`,
);
check(
  "and it says the faces were not looked for",
  warnings.length === 1 && warnings[0]!.includes("did not answer"),
  JSON.stringify(warnings),
);
check(
  "a failed detection is not cached, so the next request tries again",
  (await post("/v1/crop", { source: LANDSCAPE, width: 1080, height: 1350, strategy: "attention" }))
    .json.warnings !== undefined,
);

/**
 * `find subjects` has no other producer to fall back on, so it is the one
 * surface that refuses rather than degrades — and a deployment that never
 * configured a face service gets told which setting is missing.
 */
delete process.env[FACES_URL];
const unconfigured = await post("/v1/subjects", { source: PORTRAIT.url });
check(
  "find subjects on a deployment with no face service names the setting",
  unconfigured.status === 400 && String(unconfigured.json.error).includes(FACES_URL),
  `${String(unconfigured.status)} ${String(unconfigured.json.error)}`,
);

facesService.closeAllConnections();
await new Promise<void>((resolve) => facesService.close(() => { resolve(); }));

// ------------------------------------------------------------------- gallery

console.log("\ngallery");

const listing = await get("/v1/gallery");
const items = (listing.json.items ?? []) as { kind: string; key: string }[];
check("the Gallery answered", listing.status === 200);
check(
  "the Gallery listed every Crop just stored",
  items.filter((i) => i.kind === "crop").length === cropKeys.size,
  `${String(items.length)} items, ${String(cropKeys.size)} distinct Crops stored`,
);
check(
  "every listed Crop is content-addressed under crops/",
  items.every((i) => i.kind !== "crop" || /^crops\/[0-9a-f]{32}\.\w+$/.test(i.key)),
);
// An Annotation is a record, not a stored output. Several were written above, so
// this is a listing that had something to leave out rather than an empty claim.
check(
  "the Gallery lists no Annotation",
  items.every((i) => !i.key.startsWith("annotations/")),
  items.map((i) => i.key).join(" "),
);

const byBrand = await get("/v1/gallery?brand=laica");
check(
  "a Brand filter leaves Crops out, since a Crop has no Brand",
  ((byBrand.json.items ?? []) as { kind: string }[]).every((i) => i.kind !== "crop"),
);

const nonsense = await get("/v1/gallery?brand=nobody");
check("an unknown Brand is refused", nonsense.status === 400, String(nonsense.status));

const anonymous = await app.fetch(new Request("http://local/v1/gallery"));
check("a call with no token is refused", anonymous.status === 401, String(anonymous.status));

await rm(root, { recursive: true, force: true });

console.log(
  `\n${problems.length === 0 ? "HTTP OK" : `${String(problems.length)} FAILED`}`,
);
if (problems.length > 0) process.exitCode = 1;
