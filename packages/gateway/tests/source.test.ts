import { describe, expect, it } from "vitest";
import { MAX_OBJECT_BYTES } from "@meco/store";
import { fixtureBytes } from "./annotations";
import { HELD, KEY, PHOTOS, TIMEOUT, useStacks, fakePhotos } from "./harness";

const stack = useStacks();

const FILE = "artemis-2-crew.jpg";

/** A photograph host that answers whatever the test hands it. */
const hostAnswering = (
  answer: (url: URL, init?: RequestInit) => Promise<Response>
): ReturnType<typeof fakePhotos> => {
  const seen: string[] = [];
  return {
    seen,
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      seen.push(url.href);
      return answer(url, init);
    },
  };
};

async function annotate(
  app: ReturnType<Awaited<ReturnType<typeof stack>>["app"]>,
  url: string
) {
  const res = await app.request("/v1/annotate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ brand: HELD[0], source: { url } }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { error?: { code: string } },
  };
}

describe("a { url } Source Reference the gateway cannot use", () => {
  it(
    "is 422 source_unfetchable when the host answers anything but 2xx, and the Call is recorded failed",
    async () => {
      const one = await stack();
      const { status, body } = await annotate(one.app(), `${PHOTOS}/no.jpg`);

      expect(status).toBe(422);
      expect(body.error?.code).toBe("source_unfetchable");
      const failed = await one.records.calls.list({
        brand: HELD[0],
        status: "failed",
        limit: 10,
      });
      expect(failed.rows).toHaveLength(1);
      expect(failed.rows[0]).toMatchObject({
        kind: "annotate",
        sourceHash: null,
        error: { module: "gateway", code: "source_unfetchable" },
      });
      expect(failed.rows[0]?.steps.map((s) => s.name)).toEqual(["source.fetch"]);
      expect(one.modelsSeen).toEqual([]);
    },
    TIMEOUT
  );

  it(
    "is 422 source_unfetchable when the fetch itself fails or is cut off",
    async () => {
      const one = await stack({
        photos: hostAnswering(async () => {
          throw new DOMException("timed out", "TimeoutError");
        }),
      });
      const { status, body } = await annotate(one.app(), `${PHOTOS}/${FILE}`);
      expect(status).toBe(422);
      expect(body.error?.code).toBe("source_unfetchable");
    },
    TIMEOUT
  );

  it(
    "is 422 source_unfetchable on a 200 with no bytes, never a models refusal",
    async () => {
      const one = await stack({
        photos: hostAnswering(async () => new Response(null, { status: 200 })),
      });
      const { status, body } = await annotate(one.app(), `${PHOTOS}/${FILE}`);
      expect(status).toBe(422);
      expect(body.error?.code).toBe("source_unfetchable");
      expect(one.modelsSeen).toEqual([]);
    },
    TIMEOUT
  );

  it(
    "is 413 too_large on Content-Length alone, without reading a byte of the body",
    async () => {
      let read = false;
      const one = await stack({
        photos: hostAnswering(
          async () =>
            new Response(
              // No high-water mark, or the stream pulls once on construction
              // and `read` would say nothing about the gateway.
              new ReadableStream(
                {
                  pull() {
                    read = true;
                    throw new Error("the body was read");
                  },
                },
                { highWaterMark: 0 }
              ),
              {
                headers: {
                  "content-type": "image/jpeg",
                  "content-length": String(MAX_OBJECT_BYTES + 1),
                },
              }
            )
        ),
      });
      const { status, body } = await annotate(one.app(), `${PHOTOS}/${FILE}`);
      expect(status).toBe(413);
      expect(body.error?.code).toBe("too_large");
      expect(read).toBe(false);
    },
    TIMEOUT
  );

  it(
    "is 413 too_large by the stream when no Content-Length says so",
    async () => {
      const chunk = new Uint8Array(1024 * 1024);
      let sent = 0;
      const one = await stack({
        photos: hostAnswering(
          async () =>
            new Response(
              new ReadableStream({
                pull(controller) {
                  sent += chunk.byteLength;
                  controller.enqueue(chunk);
                  if (sent > MAX_OBJECT_BYTES * 2) controller.close();
                },
              }),
              { headers: { "content-type": "image/jpeg" } }
            )
        ),
      });
      const { status, body } = await annotate(one.app(), `${PHOTOS}/${FILE}`);
      expect(status).toBe(413);
      expect(body.error?.code).toBe("too_large");
      // Read to the bound and cancelled there, never to the end.
      expect(sent).toBeLessThan(MAX_OBJECT_BYTES * 2);
      expect(sent).toBeGreaterThan(MAX_OBJECT_BYTES);
    },
    TIMEOUT
  );

  it(
    "takes the bytes a host serves without a Content-Length",
    async () => {
      const one = await stack({
        photos: hostAnswering(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(fixtureBytes(FILE));
                  controller.close();
                },
              })
            )
        ),
      });
      const { status } = await annotate(one.app(), `${PHOTOS}/${FILE}`);
      expect(status).toBe(200);
    },
    TIMEOUT
  );
});
