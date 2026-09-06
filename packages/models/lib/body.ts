import { HostError } from "./errors";

/**
 * The most a body may be. A guard against a runaway body, not a photograph
 * bound: the largest fixture is 5.4 MB and a 12 MP JPEG at quality 90 is
 * around 6 MB.
 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

const tooLarge = () =>
  new HostError(
    "too_large",
    `the body is above ${MAX_BODY_BYTES} bytes, which is more than any photograph`
  );

/**
 * The body as received, refused above {@link MAX_BODY_BYTES} on the declared
 * length first and on the stream as it arrives, so a runaway body is never
 * held whole in memory. Exactly these bytes are hashed and decoded.
 */
export async function readBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw tooLarge();
  if (request.body === null) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request.body) {
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) throw tooLarge();
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
