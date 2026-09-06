/**
 * The wall between the two stores, proved against the live `fra1` stores rather
 * than described. These are properties of the backend — that a private object's
 * own URL refuses an unauthenticated GET, that a signature makes it serve, that
 * the signature stops working — and a fake `@vercel/blob` would prove only that
 * the fake agrees with itself.
 *
 * The private checks write under one run-scoped prefix and delete it in
 * `afterAll`, which runs whether they passed or not. The public checks write
 * nothing at all: they use the Public Store's probe object, which is already
 * there. The one wall-clock wait in the suite is the three seconds the expiry
 * check spends outliving a Signed URL.
 */
import { randomUUID } from "node:crypto";
import { head as blobHead } from "@vercel/blob";
import { afterAll, describe, expect, it } from "vitest";
import { blobStore } from "../index";

/** Run-scoped, so two runs at once never write the same Store Key. */
const RUN = randomUUID();

/** Run-scoped bytes, so no two runs share a content-addressed key. */
const bytes = (label: string): Uint8Array =>
  new TextEncoder().encode(`@meco/store urls ${RUN}: ${label}`);

const CONTENT_TYPE = "image/png";

/** Where the private checks write. A Reference Photo's shape, not a Source Image's. */
const PRIVATE_PREFIX = `people/conformance/${RUN}`;

/**
 * The Public Store's probe object: the same 70-byte 1×1 PNG `/health` round-
 * trips, under the Namespace that exists to hold it and nothing else.
 *
 * The public checks use it rather than writing their own, because a public
 * Namespace has no room for a run scope: a run-scoped payload would have to go
 * under `crops`, in the Gallery's Namespace, and a run that crashed before its
 * cleanup would leave it there. The key is the hash of these bytes, so the
 * `put` below finds the object and writes nothing.
 */
const PROBE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/**
 * The credential this test addresses the Public Store with, in the same order
 * the store itself resolves one. Written out here rather than imported so the
 * URL this test compares against comes from the SDK and not from the code under
 * test agreeing with itself.
 */
const publicAuth = () => {
  const oidcToken = process.env.VERCEL_OIDC_TOKEN;
  const storeId = process.env.BLOB_PUBLIC_STORE_ID;
  if (oidcToken !== undefined && oidcToken !== "" && storeId !== undefined) {
    return { oidcToken, storeId };
  }
  return { token: process.env.BLOB_READ_WRITE_TOKEN };
};

/** The plain private URL is the Signed URL with what signs it taken off. */
const withoutSignature = (signedUrl: string): string => {
  const url = new URL(signedUrl);
  url.search = "";
  return url.toString();
};

const store = blobStore();

/** Every key the private checks wrote, so `afterAll` can name them all. */
const written = new Set<string>();

const putPrivate = async (label: string) => {
  const payload = bytes(label);
  const { key } = await store.put(PRIVATE_PREFIX, payload, CONTENT_TYPE);
  written.add(key);
  return { key, payload };
};

describe("publicUrl against the live Public Store", () => {
  it("is byte for byte the URL the SDK hands back for the same key", async () => {
    const { key, deduped } = await store.put(
      "health-public",
      PROBE,
      CONTENT_TYPE
    );
    // Says out loud that the public checks add nothing to the Public Store.
    expect(deduped).toBe(true);

    const fromSdk = await blobHead(key, publicAuth());

    expect(store.publicUrl(key)).toBe(fromSdk.url);
  });

  it("serves the identical bytes to a caller holding nothing but the URL", async () => {
    const { key } = await store.put("health-public", PROBE, CONTENT_TYPE);

    const response = await fetch(store.publicUrl(key));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(PROBE)).toBe(true);
  });
});

describe("the wall around the live Private Store", () => {
  it("answers an unauthenticated GET of a private object's own URL with 403", async () => {
    const { key } = await putPrivate("the wall");
    // The object's real URL, taken from a Signed URL that the check below
    // fetches for 200, so this can never pass by naming a host that never was.
    const plain = withoutSignature(await store.signedUrl(key));

    const response = await fetch(plain);
    const body = await response.text();

    // The status the store actually answers, not merely "not 200": a 404 would
    // mean the key was wrong and would prove nothing about the wall.
    expect(response.status).toBe(403);
    expect(body).toBe("Forbidden\n");
  });

  it("serves the identical bytes through a Signed URL for that same object", async () => {
    const { key, payload } = await putPrivate("signed bytes");

    const response = await fetch(await store.signedUrl(key));

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
  });

  it("stops serving through a Signed URL once its seconds are up", async () => {
    const { key } = await putPrivate("expired");
    const url = await store.signedUrl(key, { expiresInSeconds: 1 });

    await new Promise((resolve) => setTimeout(resolve, 3000));
    const response = await fetch(url);

    // The cap of MAX_SIGNED_URL_SECONDS cannot be waited out inside the live
    // suite's budget, so the shortest lifetime the interface allows is what
    // proves an expiry is honoured at all. An expired signature is refused the
    // same way no signature is.
    expect(response.status).toBe(403);
  });
});

afterAll(async () => {
  await Promise.all([...written].map((key) => store.delete(key)));
});
