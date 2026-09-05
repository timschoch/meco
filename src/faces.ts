/**
 * Talking to meco-faces.
 *
 * The face stack lives in its own container — see
 * `docs/adr/0002-meco-faces-as-a-separate-service.md` — so from meco's side
 * finding a face is one HTTP call to a base URL and nothing else. This module is
 * the whole of that call: no caching, no storage, no idea what a Crop is. What
 * comes back is cached one layer up, in `./annotations.js`.
 *
 * The one thing it does to a Source Image on the way out is bound it — see
 * `LONG_EDGE`. That is not image processing on meco's behalf; it is what makes
 * the call possible at all across a platform that refuses a 4.5 MB body.
 *
 * `FACES_URL` is the only injection point, deliberately. It is what lets the
 * rewrite in `vercel.json`, a second Vercel project, a `docker run` on a laptop
 * and a canned responder in `scripts/http-probe.ts` all be the same code path —
 * and it is what makes "the second request made no call" a thing a test can
 * actually observe. Nothing else here reads the environment, and nothing else
 * reaches the network.
 */
import sharp from "sharp";
import { z } from "zod";

import type { FractionPoint } from "./crop-solver.js";

/**
 * Where meco-faces answers. Unset means face detection is simply not deployed:
 * a Crop then frames itself from its other producers and says nothing, because
 * a configuration that was never made is not a fault to report on every request.
 */
export const FACES_URL = "FACES_URL";

/**
 * How long to wait for a detection.
 *
 * Generous next to the 480 ms cold and 45 ms warm recorded in `DEPLOY.md`, and
 * still far short of a request timeout: a Crop that has waited this long is
 * better off framing itself from saliency and saying so than making the caller
 * wait for a face.
 */
const TIMEOUT_MS = 8000;

/**
 * The longest edge meco ever sends meco-faces, in pixels.
 *
 * Not a performance tuning: a Vercel Function refuses a request body over
 * 4.5 MB, and the rewrite that fronts the container is a Function. An ordinary
 * 12 MP photograph off a phone is 5–8 MB, so without a bound the whole face
 * feature is unreachable for exactly the pictures it exists for — see issue #30,
 * where a 5 424 279-byte photograph came back `413 FUNCTION_PAYLOAD_TOO_LARGE`
 * and the Crop silently fell back to `centre`.
 *
 * 1600 rather than something tighter, and rather than something larger:
 *
 * - Detection cannot tell. YuNet is fed a 640 px long edge whatever it is
 *   handed, so everything above that is thrown away inside the service. Measured
 *   on the 5878x7348 original of the group fixture, no box coordinate moves as
 *   much as 0.002 between full size and any cap down to 640 — against a
 *   hand-marked tolerance of 0.03.
 * - Embedding can, and 1600 is where it stops mattering. A Face Print is warped
 *   from a 112x112 square of the *face*, and at this cap the smallest face in that
 *   group photograph is ~100 px across — just under the template, so the warp
 *   upsamples it slightly. The print does move: 0.96 cosine against the full-size
 *   print. Identity does not. Across the four photographs the worst same-person
 *   cosine goes 0.7146 to 0.7117 and the best different-person cosine 0.2985 to
 *   0.2979, against a `MATCH_THRESHOLD` of 0.5 — a gap of 0.42 that the bound
 *   moves by 0.003. It survives much further down: the same print is still 0.79
 *   at a 320 px long edge, and only collapses at 160.
 * - 1600 px of photograph is ~0.4 MB, and 2.1 MB even for 1600x1600 of pure
 *   random noise, which is the worst thing JPEG has ever been asked to store. So
 *   the cap holds with room to spare rather than by luck of the fixtures.
 *
 * The numbers and how to reproduce them are in `DEPLOY.md`.
 */
export const LONG_EDGE = 1600;

/**
 * How many bytes a Source Image may be before it is re-encoded, whatever its size.
 *
 * A long edge is not a body size, and the platform refuses on the body size. A
 * 1600x1600 PNG of noise is 7.7 MB — within the edge and far outside the cap —
 * and a screenshot or a TIFF gets there far more plausibly than a photograph
 * does. So the pass-through is gated on both, and anything failing either is
 * re-encoded. Under the platform's own 4.5 MB, not at it: the margin is for a
 * header, a boundary and whatever the rewrite adds.
 */
export const MAX_BYTES = 4 * 1024 * 1024;

/**
 * How much of a photograph's own resolution reaches meco-faces, 0..1.
 *
 * Exported because the bound has one consequence outside this module: a face
 * measured in pixels of the photograph is not the face the service is given.
 * `MIN_FACE_PX` in `./people.js` is the rule that cares.
 */
export const sentScale = (width: number, height: number): number =>
  Math.min(1, LONG_EDGE / Math.max(width, height));

/** A Source Image in the form it is sent, and the size the photograph really is. */
export interface BoundedSource {
  bytes: Buffer;
  /**
   * Size of the Source Image as a viewer sees it, after EXIF orientation — the
   * photograph's own, which is deliberately not the size of `bytes`.
   */
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * The Source Image bounded to something the platform will carry.
 *
 * A photograph already inside both bounds is passed through untouched — the same
 * bytes, not a re-encoding of them. That is what keeps the common case free, and
 * it is also what keeps an Annotation keyed on the bytes meaningful: a small
 * photograph reaches meco-faces exactly as the caller sent it.
 *
 * Nothing downstream has to be remapped. `/detect` answers in fractions of the
 * image, and a fraction of a photograph is the same number at every resolution;
 * `/embed` is given fractions for the same reason. The one thing that is *not* a
 * fraction is the size, and that is why this returns it: the answer must describe
 * the photograph the caller has, not the copy meco chose to send.
 *
 * `.rotate()` applies EXIF orientation, because the resize works on stored pixels
 * and the tag would not survive the re-encoding. The result is upright, which is
 * the frame both services already answer in. `withoutEnlargement` matters for the
 * second bound: an image can be small and heavy at once, and stretching it to
 * 1600 px on the way to making it lighter would be absurd.
 */
export async function boundedSource(image: Buffer): Promise<BoundedSource> {
  const meta = await sharp(image).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Could not read the image dimensions — is this really an image?");
  }
  // Orientation 5..8 are the quarter-turn EXIF cases, where the stored pixels
  // are transposed relative to what anyone actually sees.
  const turned = (meta.orientation ?? 1) >= 5;
  const sourceWidth = turned ? meta.height : meta.width;
  const sourceHeight = turned ? meta.width : meta.height;

  if (sentScale(sourceWidth, sourceHeight) === 1 && image.length <= MAX_BYTES) {
    return { bytes: image, sourceWidth, sourceHeight };
  }

  // JPEG at 90 because this copy is never stored, never served and never looked
  // at by a human: it exists for two networks that see 640 px and 112 px of it.
  const bytes = await sharp(image)
    .rotate()
    .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { bytes, sourceWidth, sourceHeight };
}

/**
 * A face's box, `{ x, y, width, height }` and not `{ x, y, w, h }`.
 *
 * The wire spells it the way `SubjectBox` does, so a detected face becomes one
 * with no rename at the boundary. ADR-0002 records the decision; do not
 * "correct" it back to the plan's shorthand.
 */
export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** YuNet's five points. Every one a fraction of the image, like the box. */
export interface FaceLandmarks {
  rEye: FractionPoint;
  lEye: FractionPoint;
  nose: FractionPoint;
  rMouth: FractionPoint;
  lMouth: FractionPoint;
}

export interface DetectedFace {
  box: FaceBox;
  landmarks: FaceLandmarks;
  score: number;
}

export interface Detection {
  /** Size of the Source Image as a viewer sees it, after EXIF orientation. */
  width: number;
  height: number;
  faces: DetectedFace[];
}

/**
 * The answer, parsed rather than trusted.
 *
 * meco-faces is our own service, but it is still across a network and behind a
 * platform rewrite: a proxy error page or a stale deployment would otherwise
 * arrive as an object with no `faces` on it and fail somewhere further in, with
 * a message about a property rather than about the service.
 */
const point = z.object({ x: z.number(), y: z.number() });

const detection = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  faces: z.array(
    z.object({
      box: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
      landmarks: z.object({
        rEye: point,
        lEye: point,
        nose: point,
        rMouth: point,
        lMouth: point,
      }),
      score: z.number(),
    }),
  ),
});

/** The configured base URL with any trailing slash removed, or null. */
export function facesBaseUrl(): string | null {
  const raw = process.env[FACES_URL]?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/**
 * Every face in one Source Image.
 *
 * Throws on anything that went wrong — a service that is down, a timeout, an
 * answer that is not a detection. The caller decides what a Crop does about it;
 * here it is simply a failure with a message worth reading.
 */
export async function detectFaces(image: Buffer): Promise<Detection> {
  const base = facesBaseUrl();
  if (!base) {
    throw new Error(`${FACES_URL} is not set — meco cannot reach meco-faces.`);
  }

  const source = await boundedSource(image);
  const token = process.env.MECO_TOKEN;
  let res: Response;
  try {
    res = await fetch(`${base}/detect`, {
      method: "POST",
      headers: {
        // The body is the photograph itself. `/detect` reads the bytes and
        // sniffs the format, so the type is only ever "not JSON".
        "content-type": "application/octet-stream",
        ...(token ? { "x-auth-token": token } : {}),
      },
      body: new Uint8Array(source.bytes),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout and a refused connection arrive the same way and mean the same
    // thing to a Crop, so they are reported the same way: the service did not
    // answer, and here is where meco was looking.
    throw new Error(`meco-faces at ${base} did not answer: ${(err as Error).message}`);
  }

  if (!res.ok) {
    throw new Error(
      `meco-faces at ${base} answered ${String(res.status)}: ${(await res.text()).slice(0, 200)}`,
    );
  }

  const parsed = detection.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`meco-faces at ${base} answered something that is not a detection.`);
  }
  // The faces are fractions and so survive the bound untouched. The size does
  // not: meco-faces measured the copy it was sent, and every caller of this —
  // the Annotation, the "is this face big enough to enrol" rule — is asking
  // about the photograph.
  return { ...parsed.data, width: source.sourceWidth, height: source.sourceHeight };
}

// ---------------------------------------------------------------- face prints

/**
 * A Face Print: 512 floats on the unit sphere. Fixed by the network.
 *
 * Declared here rather than taken on trust from the answer, because a print of
 * the wrong length compares against every stored print without failing — it
 * would simply never match, and nothing downstream could say why.
 */
export const PRINT_LENGTH = 512;

/** All `/embed` needs: the five points. The box is not part of the alignment. */
export interface FaceToEmbed {
  landmarks: FaceLandmarks;
}

/**
 * The answer, parsed rather than trusted — and loosened in exactly one way.
 *
 * A `null` entry is legal since issue #39: it says "this face was not compared",
 * which is information. The `length(PRINT_LENGTH)` check stays on every entry
 * that is not null, and the count check below stays too. Relaxing either would
 * let a malformed Face Print through to be compared against the whole gallery,
 * which is the same class of defect as issue #34 — an identity read out of
 * something that does not hold one. The only thing that becomes legal here is an
 * explicit hole.
 */
const prints = z.object({
  prints: z.array(z.array(z.number()).length(PRINT_LENGTH).nullable()),
  // Absent from an older deployment of meco-faces, which is a service that
  // simply never skips: the default is the same thing it would have said.
  skipped: z
    .array(z.object({ index: z.number().int().min(0), reason: z.string() }))
    .default([]),
});

/**
 * One face meco-faces could not turn into a Face Print, and why.
 *
 * An **Uncompared Face** in `CONTEXT.md`'s terms. meco-faces calls its own half
 * of this "skipped" on the wire, and rightly: it knows nothing about Persons or
 * comparison, only that it skipped embedding a face. The name changes at this
 * boundary because the consequence is meco's, not the service's.
 */
export interface UncomparedFace {
  /** Its position in the list that was sent, so a caller can say which face. */
  index: number;
  reason: string;
}

export interface EmbeddedFaces {
  /**
   * One entry per face named, in the order they were named. `null` where
   * meco-faces could not embed that face — a hole, never a shortened list.
   */
  prints: (number[] | null)[];
  /** One entry per `null` above. Empty in the ordinary case. */
  uncompared: UncomparedFace[];
}

/**
 * The Face Print of every face named, in the order they were named.
 *
 * The faces ride in the query string, because the body is the photograph.
 * meco-faces measured 443 encoded bytes per face when only the landmarks are
 * sent, against Node's 16 KB of request line and headers — about 37 faces. A
 * Reference Photo enrols one face, so the ceiling is nowhere near; it is
 * recorded because a future caller with a crowd will meet it.
 *
 * That budget is also why one face that cannot be embedded comes back as a hole
 * rather than as one request per face: 25 faces still fit in a single call, and
 * a round trip each would be paid to solve something the response shape solves
 * for nothing. Issue #39.
 *
 * Throws on anything that went wrong *with the request*. A single face that
 * could not be embedded is not that: it is an answer, and the caller decides
 * what it means. Enrolling a Person treats it as a refusal, because there is
 * nothing else to fall back to; a Crop treats it as one face it cannot name.
 */
export async function embedFaces(
  image: Buffer,
  faces: FaceToEmbed[],
): Promise<EmbeddedFaces> {
  const base = facesBaseUrl();
  if (!base) {
    throw new Error(`${FACES_URL} is not set — meco cannot reach meco-faces.`);
  }

  // Bounded for the same reason `/detect` is: it is the same photograph over the
  // same platform rewrite. The landmarks are fractions, so they still point at
  // the same faces of the smaller copy. A Crop pays the resize twice, once here
  // and once in detection, which is a decode either way and far cheaper than the
  // upload it replaces — worth memoising only if it ever shows up in a profile.
  const { bytes } = await boundedSource(image);

  // Only the landmarks travel. Passing the box through as well would double the
  // query for a field `/embed` deliberately ignores.
  const query = encodeURIComponent(
    JSON.stringify(faces.map((f) => ({ landmarks: f.landmarks }))),
  );

  const token = process.env.MECO_TOKEN;
  let res: Response;
  try {
    res = await fetch(`${base}/embed?faces=${query}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        ...(token ? { "x-auth-token": token } : {}),
      },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`meco-faces at ${base} did not answer: ${(err as Error).message}`);
  }

  if (!res.ok) {
    throw new Error(
      `meco-faces at ${base} answered ${String(res.status)}: ${(await res.text()).slice(0, 200)}`,
    );
  }

  const parsed = prints.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(
      `meco-faces at ${base} answered something that is not a list of Face Prints.`,
    );
  }
  if (parsed.data.prints.length !== faces.length) {
    throw new Error(
      `meco-faces returned ${String(parsed.data.prints.length)} Face Prints for ` +
        `${String(faces.length)} faces.`,
    );
  }
  return { prints: parsed.data.prints, uncompared: parsed.data.skipped };
}
