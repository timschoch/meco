/**
 * The Annotation — what meco knows about one Source Image, stored under its hash.
 *
 * Detection is the expensive part of a Crop and the only part that does not
 * depend on the shape asked for, so it is done once per photograph and kept.
 * The key is the SHA-256 of the bytes, which means the same picture re-uploaded,
 * re-fetched or cropped at ten Placements is analysed exactly once. That rule is
 * what pays for the network hop to meco-faces (ADR-0002).
 *
 * An Annotation is a record, not a stored output: it is addressed by a key meco
 * chose rather than by its own content, and the Gallery never lists it. See
 * CONTEXT.md on what the Gallery is.
 *
 * ## Why IPTC Image Region
 *
 * The stored shape is the IPTC Photo Metadata Image Region structure, in IPTC's
 * own JSON serialisation, rather than a shape invented here. It is the standard
 * answer to "where in this picture is the thing", every field meco needs already
 * exists in it, and a photograph carrying regions in its own XMP could be read
 * straight into this file. Two gaps had to be filled from meco's side, and both
 * are marked with a `meco:` prefix so nothing is passed off as IPTC:
 *
 * - The region *type* vocabulary has `human` and nothing finer, so a face is a
 *   human region. Verified against <https://cv.iptc.org/newscodes/imageregiontype/>.
 * - The region *role* vocabulary has no concept for "found by software". It
 *   describes what a region is for, not where it came from. Verified against
 *   <https://cv.iptc.org/newscodes/imageregionrole/>. So provenance lives in
 *   `meco:producer`, which is also what will tell a machine region from a human
 *   override region once there are overrides.
 *
 * Every detected face gets the `subjectArea` role and none gets
 * `mainSubjectArea`, on purpose: which face a frame belongs to depends on the
 * Brand whose People are being matched, and the cache is keyed on the bytes
 * alone. Picking a leader is the solver's job, per request.
 */
import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  detectFaces,
  detectObjects,
  facesBaseUrl,
  type DetectedFace,
  type DetectedObject,
  type FaceBox,
} from "./faces.js";
import type { Storage } from "./storage.js";

/** Annotations are filed here. Not one of the Gallery's kinds. */
export const ANNOTATION_PREFIX = "annotations";

const CV_REGION_TYPE = "http://cv.iptc.org/newscodes/imageregiontype/";
const CV_REGION_ROLE = "http://cv.iptc.org/newscodes/imageregionrole/";

/** An IPTC controlled-vocabulary concept: what it is, and where that is defined. */
interface Concept {
  name: string;
  uri: string;
}

/** IPTC's rectangle, in relative units — which is to say fractions, 0..1. */
interface RegionBoundary {
  RbShape: "rectangle";
  RbUnit: "relative";
  RbX: number;
  RbY: number;
  RbW: number;
  RbH: number;
}

/** One region of one Source Image. Today always a face; later also a Person. */
export interface ImageRegion {
  RegionId: string;
  RegionName: string;
  RegionBoundary: RegionBoundary;
  rCtype: Concept[];
  rRole: Concept[];
  /** Which producer put this region here — `yunet` today, a human later. */
  "meco:producer": string;
  /** The detector's confidence, 0..1. Absent on a region a human drew. */
  "meco:score"?: number;
  /** YuNet's five points, fractions of the image. Face Blur and Match need them. */
  "meco:landmarks"?: DetectedFace["landmarks"];
  /**
   * The detector's own word for this region — `motorbike`, `person`.
   *
   * Only on an object region, and deliberately not folded into `RegionName`:
   * IPTC's name is a label for a human to read, and this is the class an
   * algorithm has to match on. Keeping them apart is what stops the kart
   * producer from selecting on a display string.
   */
  "meco:label"?: string;
}

export interface Annotation {
  /** The Source Image this describes, and the key it is filed under. */
  source: {
    /** SHA-256 of the Source Image bytes, hex. */
    hash: string;
    width: number;
    height: number;
  };
  /** When the regions were found. ISO 8601. */
  annotatedAt: string;
  /**
   * Which detectors have run over this Source Image.
   *
   * An Annotation is cached under the hash of the bytes and nothing ever
   * expires it, so a photograph annotated before a detector existed would keep
   * answering as though that detector had found nothing — silently, and
   * permanently, for exactly the photographs the new detector was added for.
   * Recording who ran turns that into a cache miss instead. Absent on an
   * Annotation written before this field existed, which reads as "nobody", which
   * is the right answer for it.
   */
  "meco:producers"?: string[];
  ImageRegion: ImageRegion[];
}

/** What `detectFaces` said, as it will be read back out of the store. */
const FACE_PRODUCER = "yunet";

/** What `detectObjects` said. The model name, so a swap invalidates the cache. */
const OBJECT_PRODUCER = "dfine-n-coco";

/**
 * Every detector a complete Annotation has been through.
 *
 * A stored Annotation missing any of these is re-detected rather than trusted.
 * Adding a detector to this list is therefore also the migration: it costs one
 * detection per photograph, once.
 */
const PRODUCERS = [FACE_PRODUCER, OBJECT_PRODUCER] as const;

/**
 * The COCO classes meco keeps out of an object detection.
 *
 * Not a filter for tidiness: it is the vocabulary the kart producer reads, and
 * it is deliberately short. `motorbike` is the class that finds a kart, because
 * COCO has none and resolves one to the nearest thing it knows; `person` is the
 * driver on top of it. The research measured `bicycle` as changing nothing and
 * `car`, `boat` and `train` as firing on the kart *and* on trackside vehicles —
 * so widening this list is a decision to measure, not a default to loosen.
 *
 * Read by `toObjectRegion` when the Annotation is written and by
 * `kartSubjectBox` when a Crop is framed. One list, because two would drift and
 * the drift would look like a detector regression.
 */
export const KART_CLASSES = ["motorbike", "person"] as const;

const HUMAN: Concept = { name: "human", uri: `${CV_REGION_TYPE}human` };

/** IPTC's type for a kart. `motorbike` is COCO's nearest word; this is IPTC's. */
const VEHICLE: Concept = { name: "vehicle", uri: `${CV_REGION_TYPE}vehicle` };

/**
 * IPTC's `subjectArea`, which is **not** meco's Subject Area.
 *
 * The names collide and the meanings do not: IPTC's role says "this rectangle is
 * a subject of the picture", which is CONTEXT.md's Subject Box. meco's Subject
 * Area is a rectangle of the *output* a Template requires the Subject to fill,
 * and never appears in an Annotation. The wire value has to stay IPTC's, so the
 * identifier carries the prefix instead.
 */
const IPTC_SUBJECT_AREA_ROLE: Concept = {
  name: "subject area",
  uri: `${CV_REGION_ROLE}subjectArea`,
};

export function sourceHash(source: Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

export function annotationKey(hash: string): string {
  return `${ANNOTATION_PREFIX}/${hash}.json`;
}

function toRegion(face: DetectedFace, index: number): ImageRegion {
  return {
    RegionId: `face-${String(index + 1)}`,
    RegionName: `Face ${String(index + 1)}`,
    RegionBoundary: {
      RbShape: "rectangle",
      RbUnit: "relative",
      RbX: face.box.x,
      RbY: face.box.y,
      RbW: face.box.width,
      RbH: face.box.height,
    },
    rCtype: [HUMAN],
    rRole: [IPTC_SUBJECT_AREA_ROLE],
    "meco:producer": FACE_PRODUCER,
    "meco:score": face.score,
    "meco:landmarks": face.landmarks,
  };
}

/**
 * One detected object as an IPTC region.
 *
 * `RegionId` is prefixed `object-` rather than continuing the `face-` numbering,
 * because the two lists are produced by different models and a caller drawing
 * boxes has to be able to tell them apart without reading `meco:producer`.
 */
function toObjectRegion(object: DetectedObject, index: number): ImageRegion {
  return {
    RegionId: `object-${String(index + 1)}`,
    RegionName: `${object.label} ${String(index + 1)}`,
    RegionBoundary: {
      RbShape: "rectangle",
      RbUnit: "relative",
      RbX: object.box.x,
      RbY: object.box.y,
      RbW: object.box.width,
      RbH: object.box.height,
    },
    rCtype: [object.label === "person" ? HUMAN : VEHICLE],
    rRole: [IPTC_SUBJECT_AREA_ROLE],
    "meco:producer": OBJECT_PRODUCER,
    "meco:score": object.score,
    "meco:label": object.label,
  };
}

/**
 * The objects an Annotation holds, back in the shape the detector spoke in.
 *
 * Selected on `meco:producer` rather than on "has no landmarks", so that the
 * face list and the object list are each defined by who made them instead of by
 * a field one of them happens to lack. A region a human drew later will have
 * neither landmarks nor this producer, and must not silently become a kart.
 */
export function objectsOf(annotation: Annotation): DetectedObject[] {
  const found: DetectedObject[] = [];
  for (const region of annotation.ImageRegion) {
    if (region["meco:producer"] !== OBJECT_PRODUCER) continue;
    const label = region["meco:label"];
    if (!label) continue;
    const b = region.RegionBoundary;
    found.push({
      label,
      score: region["meco:score"] ?? 1,
      box: { x: b.RbX, y: b.RbY, width: b.RbW, height: b.RbH },
    });
  }
  return found;
}

/**
 * The faces an Annotation holds, back in the shape the detector spoke in.
 *
 * The round trip has to be lossless, because this is what the face producer
 * frames a Crop from — a cached Annotation must yield the same window as the
 * detection that filled it, or a Crop would quietly change the second time it
 * was asked for. A region with no landmarks is skipped rather than guessed at:
 * a face with no eyes cannot carry the headroom rule.
 */
export function facesOf(annotation: Annotation): DetectedFace[] {
  return faceRegions(annotation).map((r) => r.face);
}

/**
 * The same faces, each still holding the region it was read out of.
 *
 * `facesOf` is a projection of this, not a second walk of the list, because a
 * caller that matched the faces has to say which region each Match belongs to
 * and the two answers must not be able to disagree about the order. A region
 * without landmarks is absent from both, so counting on the indices lining up
 * with `ImageRegion` would be counting on today's regions all having eyes.
 */
export function faceRegions(annotation: Annotation): { region: ImageRegion; face: DetectedFace }[] {
  const found: { region: ImageRegion; face: DetectedFace }[] = [];
  for (const region of annotation.ImageRegion) {
    if (region["meco:producer"] !== FACE_PRODUCER) continue;
    const landmarks = region["meco:landmarks"];
    if (!landmarks) continue;
    const b = region.RegionBoundary;
    const box: FaceBox = { x: b.RbX, y: b.RbY, width: b.RbW, height: b.RbH };
    found.push({ region, face: { box, landmarks, score: region["meco:score"] ?? 1 } });
  }
  return found;
}

export interface Annotated {
  annotation: Annotation;
  /** True when the store already had it, so meco-faces was not called. */
  cached: boolean;
  /** Empty when nothing went wrong. A Crop puts these in its answer. */
  warnings: string[];
}

/**
 * The Annotation for a Source Image: from the store, or from meco-faces once.
 *
 * `null` only when there is no face service configured at all. That is a
 * deployment without `FACES_URL`, not a failure, and a Crop on such a deployment
 * frames itself from its other producers and says nothing — a setting nobody
 * made is not news to report on every request.
 *
 * A detection that fails is different: it produces an Annotation missing that
 * detector's regions and a warning, and it is deliberately **not** written to
 * the store. Caching a failure would turn one bad minute into a photograph that
 * permanently has no faces in it.
 *
 * The two detectors run **together**, not one after the other. They are separate
 * models behind one service and neither reads the other's answer, so the cost of
 * the second is the slower of the two rather than their sum. Each is allowed to
 * fail on its own: a Crop of a portrait is not spoiled by an object detector
 * that timed out, and a Crop of a kart is not spoiled by a face detector that
 * found nothing to begin with.
 */
export async function annotate(source: Buffer, storage: Storage): Promise<Annotated | null> {
  if (!facesBaseUrl()) return null;

  const hash = sourceHash(source);
  const key = annotationKey(hash);

  const stored = await storage.get(key);
  if (stored) {
    try {
      const annotation = JSON.parse(stored.toString("utf8")) as Annotation;
      const ran = new Set(annotation["meco:producers"] ?? []);
      if (PRODUCERS.every((producer) => ran.has(producer))) {
        return { annotation, cached: true, warnings: [] };
      }
      // Written before one of today's detectors existed. Fall through and
      // re-detect: the alternative is a photograph that permanently answers
      // "no karts" because nobody ever looked.
    } catch {
      // Unreadable JSON at a content-addressed key is a truncated write, not a
      // different picture. Detect again and overwrite it.
    }
  }

  const [detected, spotted] = await Promise.all([
    detectFaces(source).then(
      (detection) => ({ detection, error: null }),
      (err: unknown) => ({ detection: null, error: err as Error }),
    ),
    detectObjects(source).then(
      (detection) => ({ detection, error: null }),
      (err: unknown) => ({ detection: null, error: err as Error }),
    ),
  ]);

  const warnings: string[] = [];
  if (detected.error) warnings.push(`No faces were looked for: ${detected.error.message}`);
  if (spotted.error) warnings.push(`No objects were looked for: ${spotted.error.message}`);

  // Whichever detector answered knows the size; when neither did, the picture
  // itself does. Both services measure the photograph rather than the bounded
  // copy they were sent, so the three agree.
  const meta = detected.detection ?? spotted.detection ?? (await sharp(source).metadata());

  const ran = [
    ...(detected.detection ? [FACE_PRODUCER] : []),
    ...(spotted.detection ? [OBJECT_PRODUCER] : []),
  ];

  const annotation: Annotation = {
    source: { hash, width: meta.width ?? 0, height: meta.height ?? 0 },
    annotatedAt: new Date().toISOString(),
    "meco:producers": ran,
    ImageRegion: [
      ...(detected.detection?.faces ?? []).map(toRegion),
      ...(spotted.detection?.objects ?? [])
        .filter((o) => (KART_CLASSES as readonly string[]).includes(o.label))
        .map(toObjectRegion),
    ],
  };

  // Only a complete Annotation is filed. A partial one would be cached as
  // though it were the whole answer, and the `meco:producers` check above would
  // then agree that there was nothing more to look for.
  if (warnings.length === 0) {
    await storage.putAt(key, Buffer.from(JSON.stringify(annotation)), "application/json");
  }

  return { annotation, cached: false, warnings };
}
