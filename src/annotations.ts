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

import { detectFaces, facesBaseUrl, type DetectedFace, type FaceBox } from "./faces.js";
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
  ImageRegion: ImageRegion[];
}

/** What `detectFaces` said, as it will be read back out of the store. */
const FACE_PRODUCER = "yunet";

const HUMAN: Concept = { name: "human", uri: `${CV_REGION_TYPE}human` };

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
 * A detection that fails is different: it produces an Annotation with no regions
 * and a warning, and it is deliberately **not** written to the store. Caching a
 * failure would turn one bad minute into a photograph that permanently has no
 * faces in it.
 */
export async function annotate(source: Buffer, storage: Storage): Promise<Annotated | null> {
  if (!facesBaseUrl()) return null;

  const hash = sourceHash(source);
  const key = annotationKey(hash);

  const stored = await storage.get(key);
  if (stored) {
    try {
      return { annotation: JSON.parse(stored.toString("utf8")) as Annotation, cached: true, warnings: [] };
    } catch {
      // Unreadable JSON at a content-addressed key is a truncated write, not a
      // different picture. Detect again and overwrite it.
    }
  }

  try {
    const detection = await detectFaces(source);
    const annotation: Annotation = {
      source: { hash, width: detection.width, height: detection.height },
      annotatedAt: new Date().toISOString(),
      ImageRegion: detection.faces.map(toRegion),
    };
    await storage.putAt(key, Buffer.from(JSON.stringify(annotation)), "application/json");
    return { annotation, cached: false, warnings: [] };
  } catch (err) {
    const meta = await sharp(source).metadata();
    return {
      annotation: {
        source: { hash, width: meta.width ?? 0, height: meta.height ?? 0 },
        annotatedAt: new Date().toISOString(),
        ImageRegion: [],
      },
      cached: false,
      warnings: [`No faces were looked for: ${(err as Error).message}`],
    };
  }
}
