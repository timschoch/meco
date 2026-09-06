// Bytes in, without a request body: the door refuses one (#188, measured on
// the preview). `create_upload` mints a Signed URL scoped to one `sources/`
// key, the client puts to the store, and `add_source` files what is there.
//
// No test puts to the URL: `memoryStore` mints one on `.invalid` and serves
// nothing, on purpose (`packages/store/lib/memory.ts`). What a test does
// instead is exactly what an honest client's PUT would leave behind — the
// bytes at the key the mint answered — and then calls `add_source`. Whether a
// backend honours the signature is the store's live conformance run, and the
// whole round trip is the ticket's live proof against the preview.
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MAX_OBJECT_BYTES } from "@meco/store";
import { fixtureBytes, sha256 } from "./annotations";
import { HELD, KEY, NOT_HELD, TIMEOUT, rpc, useStacks } from "./harness";

const stack = useStacks();

const FILE = "artemis-2-crew.jpg";
const BRAND = HELD[0];

type Body = Record<string, unknown> & {
  error?: { code: string; message: string };
};

type App = ReturnType<Awaited<ReturnType<typeof stack>>["app"]>;

const post = async (
  app: App,
  path: string,
  body: unknown,
  key = KEY
): Promise<{ status: number; body: Body }> => {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Body };
};

/** What a client does: mint a target, put the bytes there, name the key back. */
async function uploaded(
  one: Awaited<ReturnType<typeof stack>>,
  bytes: Uint8Array,
  mime = "image/jpeg"
) {
  const app = one.app();
  const mint = await post(app, "/v1/sources/uploads", {
    brand: BRAND,
    hash: sha256(bytes),
    mime,
    bytes: bytes.byteLength,
  });
  const key = mint.body.key as string;
  await one.store.put("sources", bytes, mime);
  return { app, mint, key };
}

describe("create_upload", () => {
  it(
    "answers a URL for the key add_source will file the bytes under, and nothing is filed yet",
    async () => {
      const one = await stack();
      const bytes = fixtureBytes(FILE);
      const hash = sha256(bytes);

      const { status, body } = await post(
        one.app(),
        "/v1/sources/uploads",
        { brand: BRAND, hash, mime: "image/jpeg", bytes: bytes.byteLength }
      );

      expect(status).toBe(200);
      expect(body.key).toBe(`sources/${hash}.jpg`);
      expect(String(body.url)).toMatch(/^https:/);
      expect(body.maxBytes).toBe(bytes.byteLength);
      expect(Date.parse(String(body.expiresAt))).toBeGreaterThan(Date.now());
      // Minting a target files nothing: a caller that asks and never uploads
      // leaves no File, no Source Hold and no bytes.
      expect(await one.records.files.get(hash)).toBeNull();
      expect(await one.records.sources.heldBy(BRAND, hash)).toBe(false);
      expect(await one.store.head(`sources/${hash}.jpg`)).toBeNull();
    },
    TIMEOUT
  );

  it(
    "refuses more than MAX_OBJECT_BYTES with 413 too_large, before the store is asked",
    async () => {
      const one = await stack();

      const { status, body } = await post(one.app(), "/v1/sources/uploads", {
        brand: BRAND,
        hash: "a".repeat(64),
        mime: "image/jpeg",
        bytes: MAX_OBJECT_BYTES + 1,
      });

      expect(status).toBe(413);
      expect(body.error?.code).toBe("too_large");
    },
    TIMEOUT
  );

  it(
    "refuses a hash that is no Content Hash and a type the store files under no extension",
    async () => {
      const one = await stack();
      const app = one.app();

      for (const bad of [
        { hash: "not-a-hash", mime: "image/jpeg" },
        { hash: "A".repeat(64), mime: "image/jpeg" },
        { hash: "a".repeat(64), mime: "image/gif" },
      ]) {
        const { status, body } = await post(app, "/v1/sources/uploads", {
          brand: BRAND,
          bytes: 1024,
          ...bad,
        });
        expect(status, JSON.stringify(bad)).toBe(400);
        expect(body.error?.code).toBe("invalid_request");
      }
    },
    TIMEOUT
  );

  it(
    "is 403 for a Brand the Caller does not hold and 401 with no key",
    async () => {
      const one = await stack();
      const app = one.app();
      const input = {
        hash: "a".repeat(64),
        mime: "image/jpeg",
        bytes: 1024,
      };

      const walled = await post(app, "/v1/sources/uploads", {
        ...input,
        brand: NOT_HELD,
      });
      expect(walled.status).toBe(403);
      expect(walled.body.error?.code).toBe("brand_not_held");

      const res = await app.request("/v1/sources/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, brand: BRAND }),
      });
      expect(res.status).toBe(401);
    },
    TIMEOUT
  );
});

describe("add_source", () => {
  it(
    "files the uploaded bytes, holds them for the Brand, and answers the hash the caller names next",
    async () => {
      const one = await stack();
      const bytes = fixtureBytes(FILE);
      const hash = sha256(bytes);
      const { app, key } = await uploaded(one, bytes);

      const { status, body } = await post(app, "/v1/sources", {
        brand: BRAND,
        key,
      });

      expect(status).toBe(200);
      expect(body).toEqual({
        hash,
        key: `sources/${hash}.jpg`,
        bytes: bytes.byteLength,
        mime: "image/jpeg",
      });

      const file = await one.records.files.get(hash);
      expect(file).not.toBeNull();
      expect(file?.storeKey).toBe(`sources/${hash}.jpg`);
      expect(file?.bytes).toBe(bytes.byteLength);
      // The decoder's own numbers, so the File and the Annotation of the same
      // photograph can never disagree about its size.
      expect(file?.width).toBeGreaterThan(0);
      expect(file?.height).toBeGreaterThan(0);
      expect(await one.records.sources.heldBy(BRAND, hash)).toBe(true);
      expect(await one.store.head(`sources/${hash}.jpg`)).not.toBeNull();
    },
    TIMEOUT
  );

  it(
    "answers a hash the caller may then name as source: { hash }",
    async () => {
      const one = await stack();
      const bytes = fixtureBytes(FILE);
      const { app, key } = await uploaded(one, bytes);

      const added = await post(app, "/v1/sources", { brand: BRAND, key });
      const annotated = await post(app, "/v1/annotate", {
        brand: BRAND,
        source: { hash: added.body.hash },
      });

      expect(annotated.status).toBe(200);
      expect(
        (annotated.body.annotation as { hash: string }).hash
      ).toBe(added.body.hash);
    },
    TIMEOUT
  );

  it(
    "is 404 when nothing was uploaded to the key, and files nothing",
    async () => {
      const one = await stack();
      const hash = sha256(fixtureBytes(FILE));

      const { status, body } = await post(one.app(), "/v1/sources", {
        brand: BRAND,
        key: `sources/${hash}.jpg`,
      });

      expect(status).toBe(404);
      expect(body.error?.code).toBe("not_found");
      expect(await one.records.files.get(hash)).toBeNull();
      expect(await one.records.sources.heldBy(BRAND, hash)).toBe(false);
    },
    TIMEOUT
  );

  it(
    "refuses bytes that do not hash to the key they were uploaded to, and deletes them",
    async () => {
      const one = await stack();
      const bytes = fixtureBytes(FILE);
      const real = sha256(bytes);
      // What a caller that lied leaves behind: bytes at a key naming another
      // photograph's hash. Written through the store's own key arithmetic
      // would be impossible, so the test writes the object as the backend
      // holds it.
      const lie = "b".repeat(64);
      const key = `sources/${lie}.jpg`;
      const store = {
        ...one.store,
        get: async (asked: string) => (asked === key ? bytes : null),
      };
      const deleted: string[] = [];
      const app = one.app({
        store: {
          ...store,
          delete: async (asked: string) => {
            deleted.push(asked);
          },
        },
      });

      const { status, body } = await post(app, "/v1/sources", {
        brand: BRAND,
        key,
      });

      expect(status).toBe(400);
      expect(body.error?.code).toBe("invalid_request");
      expect(deleted).toEqual([key]);
      // Neither hash is filed: not the one the key named, not the real one.
      expect(await one.records.files.get(lie)).toBeNull();
      expect(await one.records.files.get(real)).toBeNull();
      expect(await one.records.sources.heldBy(BRAND, real)).toBe(false);
    },
    TIMEOUT
  );

  it(
    "is 415 unsupported_mime for bytes no decoder can read",
    async () => {
      const one = await stack();
      const bytes = new TextEncoder().encode("this is not a photograph");
      const hash = sha256(bytes);
      // Uploaded as a JPEG by declaration, which is all the extension ever
      // was: what the object is, is the decoder's to say.
      const key = `sources/${hash}.jpg`;
      await one.store.put("sources", bytes, "image/jpeg");

      const { status, body } = await post(one.app(), "/v1/sources", {
        brand: BRAND,
        key,
      });

      expect(status).toBe(415);
      expect(body.error?.code).toBe("unsupported_mime");
      expect(await one.records.files.get(hash)).toBeNull();
      expect(await one.records.sources.heldBy(BRAND, hash)).toBe(false);
    },
    TIMEOUT
  );

  it(
    "is 415 unsupported_mime for an image no Annotation has a mime for",
    async () => {
      const one = await stack();
      // A real image the decoder reads without complaint, in a format the
      // Annotation's mime set does not name. The extension came from what the
      // caller declared, which is why a decoder that only refused what it
      // could not open would file this one as a JPEG.
      const bytes = new Uint8Array(
        await sharp({
          create: {
            width: 8,
            height: 8,
            channels: 3,
            background: { r: 1, g: 2, b: 3 },
          },
        })
          .tiff()
          .toBuffer()
      );
      const hash = sha256(bytes);
      await one.store.put("sources", bytes, "image/jpeg");

      const { status, body } = await post(one.app(), "/v1/sources", {
        brand: BRAND,
        key: `sources/${hash}.jpg`,
      });

      expect(status).toBe(415);
      expect(body.error?.code).toBe("unsupported_mime");
      expect(String(body.error?.message)).toContain("tiff");
      expect(await one.records.files.get(hash)).toBeNull();
    },
    TIMEOUT
  );

  it(
    "refuses a key outside the sources Namespace, so no Reference Photo can be filed as a Source",
    async () => {
      const one = await stack();
      const app = one.app();

      for (const key of [
        `people/${BRAND}/p_1/${"a".repeat(64)}.jpg`,
        `renders/${"a".repeat(64)}.png`,
        `../sources/${"a".repeat(64)}.jpg`,
      ]) {
        const { status, body } = await post(app, "/v1/sources", {
          brand: BRAND,
          key,
        });
        expect(status, key).toBe(400);
        expect(body.error?.code).toBe("invalid_request");
      }
    },
    TIMEOUT
  );

  it(
    "is 403 for a Brand the Caller does not hold, and holds nothing",
    async () => {
      const one = await stack();
      const bytes = fixtureBytes(FILE);
      const hash = sha256(bytes);
      const { app, key } = await uploaded(one, bytes);

      const { status, body } = await post(app, "/v1/sources", {
        brand: NOT_HELD,
        key,
      });

      expect(status).toBe(403);
      expect(body.error?.code).toBe("brand_not_held");
      expect(await one.records.sources.heldBy(NOT_HELD, hash)).toBe(false);
      expect(await one.records.files.get(hash)).toBeNull();
    },
    TIMEOUT
  );
});

describe("both Operations on the MCP Door", () => {
  it(
    "mint and file over tools/call, with the same answers the HTTP Door gives",
    async () => {
      const one = await stack();
      const bytes = fixtureBytes(FILE);
      const hash = sha256(bytes);
      const app = one.app();

      const mint = await rpc(app, {
        method: "tools/call",
        params: {
          name: "create_upload",
          arguments: {
            brand: BRAND,
            hash,
            mime: "image/jpeg",
            bytes: bytes.byteLength,
          },
        },
      });
      const target = (mint.result as { structuredContent: { key: string } })
        .structuredContent;
      expect(target.key).toBe(`sources/${hash}.jpg`);

      await one.store.put("sources", bytes, "image/jpeg");
      const added = await rpc(app, {
        method: "tools/call",
        params: {
          name: "add_source",
          arguments: { brand: BRAND, key: target.key },
        },
      });

      expect(
        (added.result as { structuredContent: { hash: string } })
          .structuredContent.hash
      ).toBe(hash);
      expect(await one.records.sources.heldBy(BRAND, hash)).toBe(true);
    },
    TIMEOUT
  );
});
