/**
 * Talking to meco-faces.
 *
 * The face stack lives in its own container — see
 * `docs/adr/0002-meco-faces-as-a-separate-service.md` — so from meco's side
 * finding a face is one HTTP call to a base URL and nothing else. This module is
 * the whole of that call: no caching, no storage, no idea what a Crop is. What
 * comes back is cached one layer up, in `./annotations.js`.
 *
 * `FACES_URL` is the only injection point, deliberately. It is what lets the
 * rewrite in `vercel.json`, a second Vercel project, a `docker run` on a laptop
 * and a canned responder in `scripts/http-probe.ts` all be the same code path —
 * and it is what makes "the second request made no call" a thing a test can
 * actually observe. Nothing else here reads the environment, and nothing else
 * reaches the network.
 */
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
      body: new Uint8Array(image),
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
  return parsed.data;
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
      body: new Uint8Array(image),
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
