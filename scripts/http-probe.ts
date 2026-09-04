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
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
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
import { FACES_URL, type Detection } from "../src/faces.js";
import { MIN_FACE_PX, facePrintsFor } from "../src/people.js";
import { LocalStorage, isPrivateKey } from "../src/storage.js";

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
/** One entry per detection the stand-in was asked to serve. */
const detectCalls: string[] = [];

/**
 * A Face Print the stand-in can make up, seeded from the face it was given.
 *
 * Not EdgeFace and not pretending to be: what enrolment needs from a print is
 * that it is 512 numbers on the unit sphere and that two different faces do not
 * produce the same one. Both are true of this, and neither needs ONNX Runtime in
 * this process. The real network is checked against PyTorch in
 * `packages/faces/scripts/embed-test.ts`.
 */
function cannedPrint(landmarks: Record<string, { x: number; y: number }>): number[] {
  const seed = Object.values(landmarks).reduce((a, p) => a + p.x * 7919 + p.y * 104729, 1);
  const raw = Array.from({ length: 512 }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.hypot(...raw);
  return raw.map((v) => v / norm);
}

const facesService = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    void (async () => {
      const body = Buffer.concat(chunks);
      const asked = new URL(req.url ?? "/", "http://local");
      // `/embed` turns faces the caller already found into Face Prints. It is a
      // second route on the same service, so the stand-in has to be one too, or
      // enrolment would be tested against a shape meco-faces does not have.
      if (asked.pathname === "/embed") {
        const faces = JSON.parse(asked.searchParams.get("faces") ?? "[]") as {
          landmarks: Record<string, { x: number; y: number }>;
        }[];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ prints: faces.map((f) => cannedPrint(f.landmarks)) }));
        return;
      }
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

const GROUP_DETECTION = recorded.images["artemis-2-crew.jpg"]!;
const GROUP_SIZE = { width: GROUP_DETECTION.width, height: GROUP_DETECTION.height };

/**
 * Where a face lands in the finished frame, worked out here rather than by
 * calling `facesInFrame` from `src/face-blur.js`.
 *
 * That function is what is under test. Deriving the expected rectangles from it
 * would make a mapping bug — a dropped window offset, swapped scales — move both
 * sides of every comparison together and pass. So the arithmetic is written out
 * a second time, from the recorded detection and the solved window, and the two
 * have to agree by accident of being right rather than by construction.
 */
function faceRect(
  box: { x: number; y: number; width: number; height: number },
  window: { left: number; top: number; width: number; height: number },
  out: { width: number; height: number },
) {
  const scaleX = out.width / window.width;
  const scaleY = out.height / window.height;
  const left = Math.round((box.x * GROUP_SIZE.width - window.left) * scaleX);
  const top = Math.round((box.y * GROUP_SIZE.height - window.top) * scaleY);
  const right = Math.round(((box.x + box.width) * GROUP_SIZE.width - window.left) * scaleX);
  const bottom = Math.round(((box.y + box.height) * GROUP_SIZE.height - window.top) * scaleY);
  const shows = right > 0 && left < out.width && bottom > 0 && top < out.height;
  return {
    shows,
    // What of it is actually in the picture, which is what the pixels can speak
    // about. The face itself may hang off the edge.
    left: Math.max(0, left),
    top: Math.max(0, top),
    width: Math.min(out.width, right) - Math.max(0, left),
    height: Math.min(out.height, bottom) - Math.max(0, top),
  };
}

/** Both Crops of one shape as raw pixels, and which of them differ. */
async function comparePixels(shape: { width: number; height: number }) {
  const plainCrop = await post("/v1/crop", { source: GROUP.url, ...shape, format: "png" });
  const blurCrop = await post("/v1/crop", {
    source: GROUP.url,
    ...shape,
    format: "png",
    blurUnknownFaces: true,
  });
  cropKeys.add(String(plainCrop.json.key));
  cropKeys.add(String(blurCrop.json.key));

  const raw = async (key: unknown) =>
    sharp(join(root, String(key))).raw().toBuffer({ resolveWithObject: true });
  const before = await raw(plainCrop.json.key);
  const after = await raw(blurCrop.json.key);

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
  const window = solveCrop(faceSubjectBoxes(GROUP_DETECTION.faces), GROUP_SIZE, shape, {});
  const rects = GROUP_DETECTION.faces.map((f) => faceRect(f.box, window, shape));
  return { plainCrop, blurCrop, changed, info: before.info, rects };
}

const WHOLE_GROUP = { width: 1080, height: 1350 };
const whole = await comparePixels(WHOLE_GROUP);

check(
  "every face in the window was blurred, and the answer counts them",
  whole.blurCrop.status === 200 && whole.blurCrop.json.blurred === GROUP_DETECTION.faces.length,
  `${String(whole.blurCrop.status)} blurred=${String(whole.blurCrop.json.blurred)}` +
    ` of ${String(GROUP_DETECTION.faces.length)}`,
);
check(
  "a Crop that did not ask for Face Blur says nothing about it",
  whole.plainCrop.json.blurred === undefined,
  String(whole.plainCrop.json.blurred),
);
check(
  "Face Blur changed the picture, so it is not the same Crop",
  whole.plainCrop.json.key !== whole.blurCrop.json.key,
  `${String(whole.plainCrop.json.key)} vs ${String(whole.blurCrop.json.key)}`,
);
check(
  "this shape really does hold every face, so the comparison covers them all",
  whole.rects.every((r) => r.shows),
  whole.rects.map((r) => String(r.shows)).join(" "),
);

/** Marked where any face box covers, so "outside" is every face at once. */
const covered = new Uint8Array(whole.changed.length);
for (const r of whole.rects) {
  for (let y = r.top; y < r.top + r.height; y++) {
    for (let x = r.left; x < r.left + r.width; x++) covered[y * whole.info.width + x] = 1;
  }
}

const changedInside = whole.rects.map((r) => {
  let n = 0;
  for (let y = r.top; y < r.top + r.height; y++) {
    for (let x = r.left; x < r.left + r.width; x++) n += whole.changed[y * whole.info.width + x]!;
  }
  return n / (r.width * r.height);
});
let changedOutside = 0;
for (let i = 0; i < whole.changed.length; i++) {
  if (whole.changed[i] === 1 && covered[i] === 0) changedOutside++;
}

// Half rather than all of the box: the mask is the inscribed ellipse, which is
// π/4 of the rectangle, and the corners it leaves alone are the proof of that.
check(
  "the pixels inside every face box changed",
  changedInside.length === GROUP_DETECTION.faces.length &&
    changedInside.every((share) => share > 0.5),
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
  `${String(changedOutside)} of ${String(whole.changed.length)} pixels differ`,
);

/**
 * A face the window cut in half is still a face, and the half that shows has to
 * go — right up to the edge of the frame.
 *
 * This is the case an ellipse inscribed in the visible sliver gets wrong: that
 * ellipse tapers to nothing at the frame edge, so the part of the face pressed
 * against the edge stays sharp. So the claim is measured in the one column where
 * the two answers differ most, the column on the edge itself. The real face's
 * ellipse is at its widest near there and covers almost the whole column; a
 * sliver ellipse covers almost none of it.
 */
const HALVED = { width: 450, height: 1400 };
const halved = await comparePixels(HALVED);
const cut = halved.rects.filter((r) => r.shows && r.left === 0);

check(
  "the halved shape really does cut a face at the frame edge",
  cut.length === 1 && cut[0]!.width < 60,
  `${String(cut.length)} faces on the edge, ${String(cut[0]?.width)}px of face showing`,
);
let changedOnEdge = 0;
const edge = cut[0];
if (edge) {
  for (let y = edge.top; y < edge.top + edge.height; y++) {
    changedOnEdge += halved.changed[y * halved.info.width]!;
  }
}
check(
  "a face cut by the window is hidden right up to the frame edge",
  edge !== undefined && changedOnEdge > edge.height / 2,
  `${String(changedOnEdge)} of ${String(edge?.height)} pixels on the edge changed`,
);

/**
 * A face the window cut out entirely is not in the picture, so it cannot have
 * been blurred. The shape is narrow enough that the solver has to sacrifice
 * faces — the check would prove nothing on a window that held them all.
 */
const NARROW = { width: 350, height: 1400 };
const narrowWindow = solveCrop(faceSubjectBoxes(GROUP_DETECTION.faces), GROUP_SIZE, NARROW, {});
const stillShowing = GROUP_DETECTION.faces.filter(
  (f) => faceRect(f.box, narrowWindow, NARROW).shows,
).length;
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
 * framing did not already ask for, so the Crops above — all of one photograph
 * already seen — cost no detection at all.
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

/** One MCP tool call over the app's own `/mcp` route, answered as text. */
let mcpId = 0;
async function callTool(name: string, args: Json): Promise<string> {
  mcpId++;
  const res = await app.fetch(
    new Request("http://local/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": name,
        "x-auth-token": TOKEN,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: mcpId,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "http-probe", version: "0" },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }),
  );
  const text = await res.text();
  // The SDK answers as JSON or as a one-event SSE stream; which is its business.
  const payload = JSON.parse(
    text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("") || text,
  ) as { result?: { content?: { text: string }[] } };
  return payload.result?.content?.[0]?.text ?? "";
}

const mcpAnnotation = await callTool("find_subjects", { source: PORTRAIT.url });
check(
  "the MCP tool returns the same Annotation as the route",
  mcpAnnotation !== "" &&
    JSON.stringify(JSON.parse(mcpAnnotation)) === JSON.stringify(subjects.json),
  mcpAnnotation.slice(0, 160),
);

/**
 * Face Blur over MCP, not merely advertised in the tool's schema.
 *
 * `scripts/mcp-probe.ts` checks that `crop_image` declares `blurUnknownFaces`,
 * which is what lets a client know it may send one. This is the other half: a
 * client that does send it gets a Crop with the faces gone and a count to read.
 */
const mcpBlurred = JSON.parse(
  await callTool("crop_image", {
    source: GROUP.url,
    width: 1080,
    height: 1350,
    blurUnknownFaces: true,
  }) || "{}",
) as { blurred?: number; key?: string };
cropKeys.add(String(mcpBlurred.key));
check(
  "the MCP tool blurs faces too, and counts them in its answer",
  mcpBlurred.blurred === GROUP_DETECTION.faces.length,
  `blurred=${String(mcpBlurred.blurred)} of ${String(GROUP_DETECTION.faces.length)}`,
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

// -------------------------------------------------------------------- people

console.log("\npeople");

/**
 * Enrolment is the one path that uses both halves of meco-faces, so this is
 * where the whole of it is driven: detect to find the faces, embed to turn the
 * chosen one into a Face Print, and the private store to keep both.
 *
 * The claims that matter here are not really about the happy path. They are that
 * a Reference Photo never leaves the People prefix, that no answer about a Person
 * carries a storage URL, and that deleting a Person leaves nothing behind
 * anywhere in the store. Those are data-protection properties, and a property is
 * only a property if something checks it.
 */
async function del(path: string): Promise<{ status: number; json: Json }> {
  const res = await app.fetch(
    new Request(`http://local${path}`, { method: "DELETE", headers: { "x-auth-token": TOKEN } }),
  );
  return { status: res.status, json: (await res.json()) as Json };
}

/** Every key under the temp store, so a claim about "nothing left" can be made. */
async function everyStoredKey(): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join("/"));
}

interface PersonJson extends Json {
  id: string;
  photoCount: number;
  photos: { photoId: string; face: Json; consentAt?: string }[];
}

const created = await post("/v1/people", { brand: "laica", name: "Ada Lovelace" });
const ada = created.json as PersonJson;
check(
  "a Person is created under a Brand with no photographs",
  created.status === 200 && ada.brand === "laica" && ada.photoCount === 0,
  JSON.stringify(created.json).slice(0, 160),
);

const unknownBrand = await post("/v1/people", { brand: "nobody", name: "Ada" });
check("a Person under a Brand that does not exist is refused", unknownBrand.status === 400);

const forLaica = await get("/v1/people?brand=laica");
check(
  "and appears in that Brand's People",
  ((forLaica.json.people ?? []) as PersonJson[]).some((p) => p.id === ada.id),
);
const forOthers = await get("/v1/people?brand=hopefamily");
check(
  "but not in another Brand's — a Person belongs to exactly one",
  ((forOthers.json.people ?? []) as PersonJson[]).length === 0,
);
const noBrand = await get("/v1/people");
check("listing People without naming a Brand is refused", noBrand.status === 400);

// ------------------------------------------------------------------ enrolling

const photosPath = `/v1/people/${ada.id}/photos`;

const oneFace = await post(photosPath, {
  brand: "laica",
  source: PORTRAIT.url,
  consent: true,
});
interface EnrolJson extends Json {
  results: {
    name: string;
    status: string;
    error?: string;
    photo?: { photoId: string; face: { width: number }; consentAt?: string };
    faces?: { index: number; box: { x: number; width: number }; pixels: number }[];
  }[];
}
const enrolled = (oneFace.json as EnrolJson).results[0];
check(
  "a photograph with one face enrols by itself",
  oneFace.status === 200 && enrolled?.status === "enrolled",
  JSON.stringify(oneFace.json).slice(0, 200),
);
check(
  "the enrolled face is kept as a rectangle, so the console can outline it",
  (enrolled?.photo?.face.width ?? 0) > 0,
  JSON.stringify(enrolled?.photo?.face),
);
check(
  "a ticked consent box is recorded as a timestamp on the photograph",
  typeof enrolled?.photo?.consentAt === "string",
  String(enrolled?.photo?.consentAt),
);

const groupAsked = await post(photosPath, { brand: "laica", source: GROUP.url });
const asking = (groupAsked.json as EnrolJson).results[0];
check(
  "a photograph with several faces comes back asking which one",
  groupAsked.status === 200 && asking?.status === "pick-a-face" &&
    asking.faces?.length === recorded.images["artemis-2-crew.jpg"]!.faces.length,
  `${String(groupAsked.status)} ${String(asking?.status)} ${String(asking?.faces?.length)}`,
);
check(
  "and it says how big each face is, which is what makes a choice informed",
  (asking?.faces ?? []).every((f) => f.pixels > 0 && f.index >= 0),
  JSON.stringify(asking?.faces?.[0]),
);

const picked = await post(photosPath, { brand: "laica", source: GROUP.url, faceIndex: 2 });
const pickedPhoto = (picked.json as EnrolJson).results[0];
check(
  "naming the face enrols that one",
  picked.status === 200 && pickedPhoto?.status === "enrolled",
  JSON.stringify(picked.json).slice(0, 200),
);
check(
  "and the box it stored is the face that was named, not the first one",
  pickedPhoto?.photo?.face.width ===
    recorded.images["artemis-2-crew.jpg"]!.faces[2]!.box.width,
  JSON.stringify(pickedPhoto?.photo?.face),
);
check(
  "a consent box left unticked records no consent, rather than inventing one",
  pickedPhoto?.photo?.consentAt === undefined,
  String(pickedPhoto?.photo?.consentAt),
);

const outOfRange = await post(photosPath, { brand: "laica", source: GROUP.url, faceIndex: 9 });
check(
  "a face index the photograph does not have is refused",
  outOfRange.status === 400 && String(outOfRange.json.error).includes("no face 9"),
  `${String(outOfRange.status)} ${String(outOfRange.json.error)}`,
);

const noFace = await post(photosPath, { brand: "laica", source: FACELESS.url });
check(
  "a photograph with no face in it is refused",
  noFace.status === 400 && String(noFace.json.error).includes("No face was found"),
  `${String(noFace.status)} ${String(noFace.json.error).slice(0, 120)}`,
);

/**
 * A face too small to enrol.
 *
 * EdgeFace is trained on 112x112 crops; below `MIN_FACE_PX` what comes back is a
 * Face Print of the upsampling rather than of the person. The stand-in is the
 * injection point, so a photograph with a tiny face is a recorded detection
 * rather than a photograph that had to be found.
 */
const tinyUrl = await photo(800, 600);
const tinyBytes = Buffer.from(tinyUrl.slice("data:image/jpeg;base64,".length), "base64");
const point = (x: number, y: number) => ({ x, y });
canned.set(sha(tinyBytes), {
  width: 800,
  height: 600,
  faces: [
    {
      box: { x: 0.3, y: 0.3, width: 0.03, height: 0.04 },
      landmarks: {
        rEye: point(0.305, 0.31),
        lEye: point(0.32, 0.31),
        nose: point(0.312, 0.32),
        rMouth: point(0.306, 0.33),
        lMouth: point(0.319, 0.33),
      },
      score: 0.9,
    },
  ],
});
const tooSmallFace = await post(photosPath, { brand: "laica", source: tinyUrl });
check(
  `a face under ${String(MIN_FACE_PX)} px is refused, and the refusal says how big it was`,
  tooSmallFace.status === 400 &&
    String(tooSmallFace.json.error).includes("24 px") &&
    String(tooSmallFace.json.error).includes(String(MIN_FACE_PX)),
  `${String(tooSmallFace.status)} ${String(tooSmallFace.json.error).slice(0, 140)}`,
);

// ------------------------------------------------------------------ multipart

/**
 * The upload path, which is the only one a browser has.
 *
 * Two photographs in one request, because that is what the console sends when
 * several files are dropped at once — and one of them needs a face picked, so
 * this also proves that one unusable photograph does not throw away the one
 * beside it. Vercel caps a request body at 100 MB; meco does not narrow that.
 */
const form = new FormData();
form.set("brand", "laica");
form.set("consent", "true");
form.append(
  "file",
  new File([new Uint8Array(await readFile(fixtures("astronaut-portrait.jpg")))], "portrait.jpg", {
    type: "image/jpeg",
  }),
);
form.append(
  "file",
  new File([new Uint8Array(await readFile(fixtures("artemis-2-crew.jpg")))], "crew.jpg", {
    type: "image/jpeg",
  }),
);
const uploaded = await app.fetch(
  new Request(`http://local${photosPath}`, {
    method: "POST",
    headers: { "x-auth-token": TOKEN },
    body: form,
  }),
);
const uploadJson = (await uploaded.json()) as EnrolJson;
check(
  "several photographs upload in one multipart request",
  uploaded.status === 200 && uploadJson.results.length === 2,
  `${String(uploaded.status)} ${JSON.stringify(uploadJson).slice(0, 160)}`,
);
check(
  "each is judged on its own — one enrolled, one waiting for a face to be picked",
  uploadJson.results[0]?.status === "enrolled" &&
    uploadJson.results[1]?.status === "pick-a-face",
  uploadJson.results.map((r) => `${r.name}=${r.status}`).join(" "),
);
check(
  "and each result names the file it belongs to",
  uploadJson.results[0]?.name === "portrait.jpg" && uploadJson.results[1]?.name === "crew.jpg",
  uploadJson.results.map((r) => r.name).join(" "),
);

/**
 * A face index belongs to one photograph.
 *
 * The console never sends one with a batch — it re-sends the picked photograph
 * on its own — but the HTTP API is reachable without the console, and an index
 * that means face 2 in a group photograph means nobody in a portrait.
 */
const batchWithIndex = new FormData();
batchWithIndex.set("brand", "laica");
batchWithIndex.set("faceIndex", "1");
for (const name of ["astronaut-portrait.jpg", "artemis-2-crew.jpg"]) {
  batchWithIndex.append(
    "file",
    new File([new Uint8Array(await readFile(fixtures(name)))], name, { type: "image/jpeg" }),
  );
}
const refusedBatch = await app.fetch(
  new Request(`http://local${photosPath}`, {
    method: "POST",
    headers: { "x-auth-token": TOKEN },
    body: batchWithIndex,
  }),
);
check(
  "a face index sent with several photographs at once is refused",
  refusedBatch.status === 400 &&
    String(((await refusedBatch.json()) as Json).error).includes("on its own"),
  String(refusedBatch.status),
);

// -------------------------------------------------------------- what is kept

const withPhotos = await get(`/v1/people?brand=laica`);
const stored = ((withPhotos.json.people ?? []) as PersonJson[]).find((p) => p.id === ada.id);
check(
  "the Person now counts every Reference Photo enrolled",
  stored?.photoCount === 2 && stored.photos.length === 2,
  `photoCount=${String(stored?.photoCount)}`,
);

const peopleKeys = (await everyStoredKey()).filter((k) => k.startsWith("people/"));
check(
  "every Reference Photo and Face Print is under the People prefix",
  peopleKeys.length > 0 && peopleKeys.every((k) => isPrivateKey(k)),
  `${String(peopleKeys.length)} keys`,
);
check(
  "and each of them is filed under the Brand and the Person",
  peopleKeys.every((k) => k.startsWith(`people/laica/${ada.id}/`)),
  peopleKeys.slice(0, 3).join(" "),
);
check(
  "a Face Print is stored beside each photograph, 512 floats on the unit sphere",
  await (async () => {
    const printKeys = peopleKeys.filter((k) => k.endsWith(".print.json"));
    if (printKeys.length !== stored?.photos.length) return false;
    for (const key of printKeys) {
      const record = JSON.parse(await readFile(join(root, key), "utf8")) as { print: number[] };
      const length = Math.hypot(...record.print);
      if (record.print.length !== 512 || Math.abs(length - 1) > 1e-6) return false;
    }
    return true;
  })(),
  peopleKeys.filter((k) => k.endsWith(".print.json")).join(" "),
);
check(
  "no answer about a Person carries a storage URL for a Reference Photo",
  !JSON.stringify(withPhotos.json).includes("people/") &&
    !JSON.stringify(withPhotos.json).includes("http://local"),
  JSON.stringify(withPhotos.json).slice(0, 160),
);

/**
 * People are personal data and never a stored output, so the Gallery leaves them
 * out. Asked here rather than in the gallery section below, because here there
 * are Reference Photos and Face Prints in the store for it to leave out.
 */
const galleryWithPeople = await get("/v1/gallery");
check(
  "the Gallery lists no Person, no Reference Photo and no Face Print",
  ((galleryWithPeople.json.items ?? []) as { key: string }[]).every((i) => !isPrivateKey(i.key)),
  ((galleryWithPeople.json.items ?? []) as { key: string }[]).map((i) => i.key).join(" "),
);

/** The seam #14 matches against: every Face Print this Brand has enrolled. */
const brandPrints = await facePrintsFor("laica", storage);
check(
  "every Face Print of a Brand is reachable through one lookup",
  brandPrints.length === stored?.photos.length &&
    brandPrints.every((p) => p.personId === ada.id && p.personName === "Ada Lovelace"),
  `${String(brandPrints.length)} prints`,
);

// ------------------------------------------------- serving a Reference Photo

const firstPhotoId = stored!.photos[0]!.photoId;
const bytesPath = `/v1/people/${ada.id}/photos/${firstPhotoId}?brand=laica`;
const servedRes = await app.fetch(
  new Request(`http://local${bytesPath}`, { headers: { "x-auth-token": TOKEN } }),
);
check(
  "a Reference Photo is served by meco itself, as an image",
  servedRes.status === 200 && (servedRes.headers.get("content-type") ?? "").startsWith("image/"),
  `${String(servedRes.status)} ${String(servedRes.headers.get("content-type"))}`,
);
check(
  "and never from a shared cache",
  (servedRes.headers.get("cache-control") ?? "").includes("no-store"),
  String(servedRes.headers.get("cache-control")),
);
const servedAnonymously = await app.fetch(new Request(`http://local${bytesPath}`));
check(
  "a Reference Photo is not served to a caller with no token",
  servedAnonymously.status === 401,
  String(servedAnonymously.status),
);

// --------------------------------------------------------------- deleting

const removed = await del(bytesPath);
check(
  "removing one Reference Photo leaves the Person standing",
  removed.status === 200 && (removed.json as PersonJson).photoCount === 1,
  JSON.stringify(removed.json).slice(0, 140),
);
/**
 * Scoped to the People prefix on purpose.
 *
 * A photoId is the first 32 hex of the SHA-256 of the photograph, and an
 * Annotation of the same photograph is filed under the whole 64 — so a bare
 * substring search matches the Annotation of a Crop made earlier in this run and
 * would fail on a name rather than on anything left behind.
 */
const leftBehind = (await everyStoredKey()).filter(
  (k) => k.startsWith("people/") && k.includes(firstPhotoId),
);
check(
  "and takes that photograph's Face Print with it",
  leftBehind.length === 0,
  leftBehind.join(" "),
);

/**
 * The cascade, which is the whole reason a Person's things live under one prefix.
 *
 * Checked against the store rather than against the record: the record is what a
 * half-finished enrolment could be missing an entry from, and personal data left
 * behind that nothing points at is the one outcome this must not have.
 */
const before = await everyStoredKey();
check(
  "before deleting, the store does hold this Person's things",
  before.some((k) => k.includes(ada.id)),
  `${String(before.filter((k) => k.includes(ada.id)).length)} keys`,
);
const gone = await del(`/v1/people/${ada.id}?brand=laica`);
check("deleting a Person is accepted", gone.status === 200, JSON.stringify(gone.json));
check(
  "and leaves nothing of them anywhere in the store, under any prefix",
  !(await everyStoredKey()).some((k) => k.includes(ada.id)),
  (await everyStoredKey()).filter((k) => k.includes(ada.id)).join(" "),
);
check(
  "the Brand's People no longer name them",
  !(((await get("/v1/people?brand=laica")).json.people ?? []) as PersonJson[]).some(
    (p) => p.id === ada.id,
  ),
);
check(
  "and their Face Prints are gone from the Brand's lookup too",
  (await facePrintsFor("laica", storage)).length === 0,
);
check(
  "deleting a Person who is already gone is refused rather than silently accepted",
  (await del(`/v1/people/${ada.id}?brand=laica`)).status === 400,
);

/**
 * Enrolling files nothing outside the People prefix.
 *
 * A Crop caches an Annotation under the hash of the Source Image; enrolling
 * deliberately does not, because a Reference Photo must leave no trace outside
 * `people/`. The photograph here is made for this check and cropped nowhere, so
 * an `annotations/` entry for it could only have come from the enrolment.
 */
const freshUrl = await photo(900, 700);
const freshBytes = Buffer.from(freshUrl.slice("data:image/jpeg;base64,".length), "base64");
canned.set(sha(freshBytes), {
  width: 900,
  height: 700,
  faces: [
    {
      box: { x: 0.35, y: 0.2, width: 0.2, height: 0.26 },
      landmarks: {
        rEye: point(0.4, 0.28),
        lEye: point(0.5, 0.28),
        nose: point(0.45, 0.33),
        rMouth: point(0.41, 0.39),
        lMouth: point(0.49, 0.39),
      },
      score: 0.98,
    },
  ],
});
const grace = (await post("/v1/people", { brand: "laica", name: "Grace Hopper" }))
  .json as PersonJson;
const graceEnrolled = await post(`/v1/people/${grace.id}/photos`, {
  brand: "laica",
  source: freshUrl,
});
check(
  "a photograph never cropped enrols",
  (graceEnrolled.json as EnrolJson).results[0]?.status === "enrolled",
  JSON.stringify(graceEnrolled.json).slice(0, 140),
);
check(
  "and enrolling it wrote no Annotation, so nothing about a Person is filed outside the People prefix",
  !(await everyStoredKey()).includes(`annotations/${sha(freshBytes)}.json`),
  (await everyStoredKey()).filter((k) => k.startsWith("annotations/")).join(" "),
);
await del(`/v1/people/${grace.id}?brand=laica`);

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
