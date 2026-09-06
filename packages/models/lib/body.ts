import { HostError } from "./errors";

/**
 * The most a body may be. A guard against a runaway body, not a photograph
 * bound: the largest fixture is 5.4 MB and a 12 MP JPEG at quality 90 is
 * around 6 MB.
 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

export const tooLarge = (): HostError =>
  new HostError(
    "too_large",
    `the body is above ${MAX_BODY_BYTES} bytes, which is more than any photograph`
  );

/**
 * The length a body declares, refused above {@link MAX_BODY_BYTES} before a
 * byte of it is read. A header that is absent or is not a number declares
 * nothing, and the stream check below is what bounds it then.
 */
export function assertDeclaredLength(header: string | null): void {
  const declared = Number(header ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge();
}

/**
 * Every byte of a stream, refused above {@link MAX_BODY_BYTES} as it arrives,
 * so a runaway body is never held whole in memory. Shared by the two body
 * shapes: the request's own bytes, and the bytes a `{ url }` body was fetched.
 */
export async function collect(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        // Cancelled and not merely abandoned: the far side is still sending,
        // and a body this guard refuses is by definition the large one.
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The body as received, refused above {@link MAX_BODY_BYTES} on the declared
 * length first and on the stream as it arrives. Exactly these bytes are hashed
 * and decoded.
 */
export async function readBody(request: Request): Promise<Uint8Array> {
  assertDeclaredLength(request.headers.get("content-length"));
  if (request.body === null) return new Uint8Array(0);
  return collect(request.body);
}
