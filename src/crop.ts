/**
 * Cropping a Source Image to a required shape. See CONTEXT.md.
 *
 * A Crop is a sibling of a Render, not a kind of one: it involves no Template.
 * What it is not any more is a gravity string handed to the image library. Every
 * framing input — the Crop Anchor the caller named, the saliency point sharp
 * reads out of the picture, the faces meco-faces found — becomes a Subject Box,
 * and `solveCrop` in `./crop-solver.js` turns the Subject Boxes into the window.
 * This file is the half that has to touch pixels; the framing itself lives next
 * door, where it can be tested without an image.
 */
import sharp from "sharp";

import {
  solveCrop,
  type CropFallback,
  type CropProducer,
  type FractionPoint,
  type PixelSize,
  type SubjectArea,
  type SubjectBox,
} from "./crop-solver.js";
import { blurFaces, facesInFrame, unknownFaces } from "./face-blur.js";
import type { DetectedFace } from "./faces.js";
import type { Match } from "./people.js";

export type { SubjectArea };

/**
 * What a Crop is asked to frame itself on, when the caller has a preference.
 *
 * A preference and not an instruction: `person` still falls through to the faces
 * and then to saliency when nobody was recognised, because a Crop always has to
 * come out. Only `attention` is exclusive — it is how a caller says "ignore the
 * faces", which is otherwise unsayable once meco can see them.
 */
export const PIN_TO = ["person", "faces", "attention"] as const;

export type PinTo = (typeof PIN_TO)[number];

/** The nine regions of a Source Image a Crop can keep. */
export const CROP_ANCHORS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;

export type CropAnchor = (typeof CROP_ANCHORS)[number];

/**
 * Where a Crop Anchor puts its point — in the Source Image and in the frame.
 *
 * One table for both, because a Crop Anchor is precisely the statement that
 * those two agree: "top-left" keeps the top-left corner of the picture in the
 * top-left corner of the frame. That is what makes the anchor a Subject Box
 * like any other instead of a special case inside the solver.
 */
const ANCHOR_AT: Record<CropAnchor, FractionPoint> = {
  "top-left": { x: 0, y: 0 },
  top: { x: 0.5, y: 0 },
  "top-right": { x: 1, y: 0 },
  left: { x: 0, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  right: { x: 1, y: 0.5 },
  "bottom-left": { x: 0, y: 1 },
  bottom: { x: 0.5, y: 1 },
  "bottom-right": { x: 1, y: 1 },
};

/**
 * How the producers rank when several speak at once.
 *
 * A found face outranks everything a caller or an image statistic can say: the
 * saliency point is a guess at what a photograph is of, and a face is an answer.
 * A matched Person outranks the face for the same reason again — a face says
 * "the picture is of somebody", a Match says who.
 */
const PRIORITY: Record<CropProducer, number> = {
  person: 50,
  face: 40,
  saliency: 30,
  anchor: 20,
  centre: 10,
};

/**
 * How far below the leading face the other faces rank.
 *
 * They are still faces and still worth more than any other producer, so they sit
 * one step down rather than at the bottom. The step is what makes the leader a
 * tier of its own: the solver composes on the top tier alone and only consults
 * the rest to check they survived, which is what "pin on this face, keep the
 * others in frame when possible" means as an arithmetic.
 */
const SUPPORTING_FACE_STEP = 1;

/** The short side of the resize sharp reads the saliency point from. */
const SALIENCY_READ_PX = 32;

export interface CropRequest {
  source: Buffer;
  width: number;
  height: number;
  /**
   * The faces already found in this Source Image, from its Annotation.
   *
   * Passed in rather than looked up here, because finding them means a hash, a
   * store and a network call, and this module is the half that touches pixels.
   * `src/api.ts` owns that half. It also means a Crop can be solved from a face
   * without any of it — which is what the tests do.
   */
  faces?: readonly DetectedFace[];
  /**
   * Which of those faces meco could put a name to, one entry per face in the
   * same order and `null` for the strangers.
   *
   * Passed in for the same reason the faces are: matching means a store, a Brand
   * and a second network call, and none of that belongs in the half that touches
   * pixels. `src/api.ts` owns it.
   */
  matches?: readonly (Match | null)[];
  /**
   * What to frame on. Defaults to `person`, which is the same as `faces` until
   * something matches, so a caller who never heard of a Person is unaffected.
   */
  pinTo?: PinTo;
  anchor?: CropAnchor;
  /**
   * Let the picture decide instead of the caller. Either value selects the
   * saliency producer; they differ only in which window sharp is asked for, the
   * one its attention map picks or the one its entropy map does.
   */
  strategy?: "attention" | "entropy";
  /**
   * Where in the output frame the Subject has to land. Without one the solver
   * uses the golden grid, which is what every Crop did before Templates could
   * ask for anything more exact.
   */
  subjectArea?: SubjectArea;
  /**
   * Hide every face in the finished frame that is not a known Person.
   *
   * Off unless asked for: blurring a face is a decision about the picture, and
   * a Crop that quietly made it would be worse than one that never offered it.
   */
  blurUnknownFaces?: boolean;
  format?: "png" | "jpeg" | "webp";
  quality?: number;
}

export interface CropResult {
  data: Buffer;
  width: number;
  height: number;
  contentType: string;
  /** What actually decided the framing, for the response and for debugging. */
  resolvedBy: CropProducer;
  /** Every Subject marked `keep` survived the composition first asked for. */
  satisfied: boolean;
  /** Which rung of the fallback ladder rescued the window, if any. */
  fallback?: CropFallback;
  /** Only when the request named a Subject Area: the Subject landed inside it. */
  subjectAreaSatisfied?: boolean;
  /** Only when the Crop Anchor decided. */
  anchor?: CropAnchor;
  /**
   * How many faces were hidden. Only when Face Blur was asked for, and then
   * always — a Crop that found nothing to hide has to say zero rather than
   * leave the caller guessing whether the option took effect.
   */
  blurred?: number;
}

/**
 * The saliency point, in fractions of the Source Image, or null.
 *
 * sharp will only say where it is looking as a side effect of actually cropping,
 * so the read is a throwaway resize down to a 32-pixel short side — three
 * kilobytes of pixels instead of a full-size crop nobody keeps. The shape has to
 * match the shape the Crop is for, since that is the window the strategy is
 * choosing.
 *
 * The answer is read off `cropOffsetLeft/Top`, the window the strategy picked,
 * and not off `attentionX/Y`. The research note claims that field is rescaled
 * back to Source Image pixels; measured against sharp 0.35 it is not. On a
 * 1600×1000 photograph whose Subject sits at 0.68 of the width, a 32-pixel probe
 * reports `attentionX` 33 for a PNG and 264 for the same picture as a JPEG — the
 * resized-probe coordinate multiplied by whatever shrink-on-load the decoder
 * chose, which is not a factor sharp exposes. The window offset needs only the
 * resize scale undone and reads 0.645 at every probe size and in both formats.
 * Since libvips centres that window on the attention point, its centre is the
 * point back again, give or take the clamping at the edge of the picture.
 *
 * Both strategies answer the same way, so both go through here. It can also
 * legitimately answer nothing: a request whose shape already matches the Source
 * Image needs no crop, libvips skips the block, and no offset comes back. That
 * is a fall-through to the next producer, not an error.
 */
async function saliencyPoint(
  data: Buffer,
  source: PixelSize,
  aspect: number,
  strategy: "attention" | "entropy",
): Promise<FractionPoint | null> {
  const probe =
    aspect >= 1
      ? { width: Math.max(1, Math.round(SALIENCY_READ_PX * aspect)), height: SALIENCY_READ_PX }
      : { width: SALIENCY_READ_PX, height: Math.max(1, Math.round(SALIENCY_READ_PX / aspect)) };

  const { info } = await sharp(data)
    .resize(probe.width, probe.height, {
      fit: "cover",
      position: sharp.strategy[strategy],
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Negated, and in the resized image rather than the Source Image, so both have
  // to be undone before the centre of the window means anything.
  const { cropOffsetLeft, cropOffsetTop } = info;
  if (cropOffsetLeft === undefined || cropOffsetTop === undefined) return null;
  const scale = Math.max(probe.width / source.width, probe.height / source.height);
  return {
    x: (-cropOffsetLeft + probe.width / 2) / scale / source.width,
    y: (-cropOffsetTop + probe.height / 2) / scale / source.height,
  };
}

/**
 * Which detected face the frame belongs to.
 *
 * A matched Person, whatever size their face is — that is what pinning on a
 * Person means, and it is the whole reason the picture was matched at all. A
 * Person three metres behind the crowd still leads the Crop.
 *
 * Among several Matches the strongest one leads. Picking the largest instead
 * would let the framing wobble between two people from one photograph to the
 * next as they move about, whereas the similarity is a statement about who meco
 * is surest of and does not depend on where anybody stood.
 *
 * With no Match at all the rule is the one it has always been: the largest face,
 * because in a photograph the biggest face is almost always the one the
 * photograph is of. Nothing else in the producer knows how the leader was
 * picked.
 */
function leadingFace(
  faces: readonly DetectedFace[],
  matches: readonly (Match | null)[],
): number {
  const area = (f: DetectedFace) => f.box.width * f.box.height;
  let lead = 0;
  for (let i = 1; i < faces.length; i++) {
    const challenger = matches[i] ?? null;
    const holder = matches[lead] ?? null;
    if (challenger && !holder) lead = i;
    else if (challenger && holder) {
      if (challenger.score > holder.score) lead = i;
    } else if (!holder && area(faces[i]!) > area(faces[lead]!)) lead = i;
  }
  return lead;
}

/**
 * The detected faces as Subject Boxes.
 *
 * Every face is kept, so every face is in the containment test and the fallback
 * ladder has to try to hold all of them; a face that is not leading is what the
 * `drop` rung sacrifices first, because it ranks lower. That is "other faces are
 * kept in frame when possible" stated as data rather than as a special case in
 * the solver.
 *
 * The eye midpoint goes on every face, not only the leader. Reading it off each
 * face costs nothing, and the solver takes it from whichever box wins the anchor
 * — so the rule keeps working when the leader stops being the largest one.
 *
 * Exported because it is the whole of the face producer and it is arithmetic:
 * `scripts/crop-solver-test.ts` frames real detections with it and reads the
 * window back, which is how the eye line is held to 2 % without an image.
 */
export function faceSubjectBoxes(
  faces: readonly DetectedFace[],
  matches: readonly (Match | null)[] = [],
): SubjectBox[] {
  const lead = leadingFace(faces, matches);

  /**
   * The four kinds of face a photograph can hold, stated once.
   *
   * Only the leading face of a matched Crop is a `person` box, because
   * `resolvedBy` is read off whichever box won the anchor and "framed on a
   * Person" is what that word has to mean. A second Match is still a face — but
   * a known one, so it outranks a stranger, and a stranger is what the `drop`
   * rung sacrifices first.
   */
  const tierOf = (leading: boolean, matched: boolean) =>
    leading
      ? matched
        ? { producer: "person" as const, priority: PRIORITY.person }
        : { producer: "face" as const, priority: PRIORITY.face }
      : matched
        ? { producer: "face" as const, priority: PRIORITY.face }
        : { producer: "face" as const, priority: PRIORITY.face - SUPPORTING_FACE_STEP };

  return faces.map((face, i) => ({
    x: face.box.x,
    y: face.box.y,
    width: face.box.width,
    height: face.box.height,
    ...tierOf(i === lead, matches[i] != null),
    keep: true,
    eyeY: (face.landmarks.rEye.y + face.landmarks.lEye.y) / 2,
  }));
}

/**
 * Every Subject Box this Crop has to go on, from the producers in order.
 *
 * Faces first, because a face is the answer the others are guessing at. Then
 * saliency when the caller asked the picture to decide, then the Crop Anchor the
 * caller named, then the centre — the anchor nobody named. The first producer
 * that yields a box wins the framing.
 */
async function subjectBoxes(
  data: Buffer,
  source: PixelSize,
  aspect: number,
  req: CropRequest,
): Promise<SubjectBox[]> {
  const point = (producer: CropProducer, at: FractionPoint, framed?: FractionPoint) => ({
    x: at.x,
    y: at.y,
    width: 0,
    height: 0,
    producer,
    priority: PRIORITY[producer],
    keep: true,
    ...(framed ? { framedAt: framed } : {}),
  });

  const pinTo = req.pinTo ?? "person";

  // `attention` is the one setting that steps over the faces. The other two both
  // frame on a face and differ only in whether a name is allowed to change which
  // face leads — so `faces` is served by handing the producer no Matches, which
  // is exactly what "ignore who they are" means.
  if (pinTo !== "attention" && req.faces && req.faces.length > 0) {
    return faceSubjectBoxes(req.faces, pinTo === "person" ? (req.matches ?? []) : []);
  }

  // Asking to pin on attention is asking the picture to decide, so it selects
  // the saliency producer on its own rather than needing a strategy beside it.
  const strategy = req.strategy ?? (pinTo === "attention" ? "attention" : undefined);
  if (strategy) {
    const found = await saliencyPoint(data, source, aspect, strategy);
    if (found) return [point("saliency", found)];
  }
  if (req.anchor) {
    const at = ANCHOR_AT[req.anchor];
    return [point("anchor", at, at)];
  }
  const centre = ANCHOR_AT.center;
  return [point("centre", centre, centre)];
}

export async function cropImage(req: CropRequest): Promise<CropResult> {
  const { source, width, height, anchor, format = "jpeg", quality = 88 } = req;

  if (anchor !== undefined && !CROP_ANCHORS.includes(anchor)) {
    throw new Error(
      `Unknown Crop Anchor "${anchor}". Use one of: ${CROP_ANCHORS.join(", ")}.`,
    );
  }

  const meta = await sharp(source).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Could not read the size of the Source Image.");
  }
  const size: PixelSize = { width: meta.width, height: meta.height };
  const aspect = width / height;

  const boxes = await subjectBoxes(source, size, aspect, req);
  const window = solveCrop(boxes, size, { width, height }, {
    ...(req.subjectArea ? { subjectArea: req.subjectArea } : {}),
  });

  // Cut the window the solver chose, then scale it to the size asked for. `fill`
  // rather than `cover`, because the window is already the required shape up to
  // the rounding to whole pixels — letting sharp cover it a second time would
  // undo the framing this whole module exists to compute.
  let pipeline = sharp(source)
    .extract({
      left: window.left,
      top: window.top,
      width: window.width,
      height: window.height,
    })
    .resize(width, height, { fit: "fill" });

  // Face Blur goes on the framed pixels, between the resize and the encode. A
  // Crop that did not ask for it never enters this branch and so is the same
  // bytes it has always been.
  // The Matches are consulted here whatever `pinTo` said. Which face leads the
  // framing is a composition choice; who may be shown is not. A caller who
  // pinned on attention still gets their own Person's face left sharp, because
  // "blur the people we do not know" does not become a different sentence
  // because the framing was decided by something else.
  const hiddenFaces = req.blurUnknownFaces
    ? facesInFrame(unknownFaces(req.faces ?? [], req.matches ?? []), size, window, {
        width,
        height,
      })
    : [];
  if (hiddenFaces.length > 0) pipeline = await blurFaces(pipeline, hiddenFaces);

  if (format === "png") pipeline = pipeline.png();
  else if (format === "webp") pipeline = pipeline.webp({ quality });
  else pipeline = pipeline.jpeg({ quality });

  const data = await pipeline.toBuffer();

  return {
    data,
    width,
    height,
    contentType: `image/${format}`,
    resolvedBy: window.resolvedBy,
    satisfied: window.satisfied,
    ...(window.fallback ? { fallback: window.fallback } : {}),
    ...(window.subjectAreaSatisfied === undefined
      ? {}
      : { subjectAreaSatisfied: window.subjectAreaSatisfied }),
    ...(window.resolvedBy === "anchor" && anchor ? { anchor } : {}),
    ...(req.blurUnknownFaces ? { blurred: hiddenFaces.length } : {}),
  };
}

/** Fetch a Source Image the caller referenced by URL. */
export async function fetchSourceImage(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "user-agent": "meco/0.1 (+social image renderer)" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch source image ${url}: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
