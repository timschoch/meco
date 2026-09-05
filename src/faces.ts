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
 *   from a 112x112 square of the *face*, so the smallest face in that group
 *   photograph still has ~113 px to give at this cap. The print does move — 0.96
 *   cosine against the full-size print — but identity does not: on the fixtures
 *   the worst same-person cosine goes 0.7146 to 0.7117 and the best
 *   different-person cosine 0.2985 to 0.2979, against a `MATCH_THRESHOLD` of 0.5.
 * - 1600 px of photograph is ~0.4 MB, an order of magnitude under the cap, so a
 *   noisier picture than the fixtures has room to be larger without ever
 *   approaching it.
 *
 * The numbers and how to reproduce them are in `DEPLOY.md`.
 */
export const LONG_EDGE = 1600;

/** A Source Image in the form it is sent, and the size it actually is. */
export interface BoundedSource {
  bytes: Buffer;
  /** Size of the Source Image as a viewer sees it, after EXIF orientation. */
  width: number;
  height: number;
}

/**
 * The Source Image bounded to something the platform will carry.
 *
 * A photograph already within the cap is passed through untouched — the same
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
 * the frame both services already answer in.
 */
export async function boundedSource(image: Buffer): Promise<BoundedSource> {
  const meta = await sharp(image).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Could not read the image dimensions — is this really an image?");
  }
  // Orientation 5..8 are the quarter-turn EXIF cases, where the stored pixels
  // are transposed relative to what anyone actually sees.
  const turned = (meta.orientation ?? 1) >= 5;
  const width = turned ? meta.height : meta.width;
  const height = turned ? meta.width : meta.height;

  if (Math.max(width, height) <= LONG_EDGE) return { bytes: image, width, height };

  // JPEG at 90 because this copy is never stored, never served and never looked
  // at by a human: it exists for two networks that see 640 px and 112 px of it.
  const bytes = await sharp(image)
    .rotate()
    .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: "inside" })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { bytes, width, height };
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
  return { ...parsed.data, width: source.width, height: source.height };
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

const prints = z.object({
  prints: z.array(z.array(z.number()).length(PRINT_LENGTH)),
});

/**
 * The Face Print of every face named, in the order they were named.
 *
 * The faces ride in the query string, because the body is the photograph.
 * meco-faces measured 443 encoded bytes per face when only the landmarks are
 * sent, against Node's 16 KB of request line and headers — about 37 faces. A
 * Reference Photo enrols one face, so the ceiling is nowhere near; it is
 * recorded because a future caller with a crowd will meet it.
 *
 * Throws on anything that went wrong. Enrolling a Person is not a Crop: there is
 * no other producer to fall back to, so a failure here is a failure of the
 * request and is reported as one.
 */
export async function embedFaces(image: Buffer, faces: FaceToEmbed[]): Promise<number[][]> {
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
  return parsed.data.prints;
}
