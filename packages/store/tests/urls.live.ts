/**
 * The wall between the two stores, proved against the live `fra1` stores rather
 * than described. These are properties of the backend — that a private object's
 * own URL refuses an unauthenticated GET, that a signature makes it serve, that
 * the signature stops working — and a fake `@vercel/blob` would prove only that
 * the fake agrees with itself.
 *
 * Everything written here is deleted in `afterAll`, which runs whether the
 * checks passed or not.
 */
import { randomUUID } from "node:crypto";
import { head as blobHead } from "@vercel/blob";
import { afterAll, describe, expect, it } from "vitest";
import { blobStore } from "../index";

/** Run-scoped, so two runs at once never write the same Store Key. */
const RUN = randomUUID();

/** Run-scoped bytes, so the content-addressed public key is this run's alone. */
const bytes = (label: string): Uint8Array =>
  new TextEncoder().encode(`@meco/store urls ${RUN}: ${label}`);

const CONTENT_TYPE = "image/png";

/** Where the private checks write. A Reference Photo's shape, not a Source Image's. */
const PRIVATE_PREFIX = `people/conformance/${RUN}`;

/**
 * Where the public check writes. A public Namespace has no room for a run
 * scope — the key is `crops/<sha256>.png` — so the payload carries the run id
 * instead, and the object is deleted afterwards.
 */
const PUBLIC_PREFIX = "crops";

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

/** Every key the checks wrote, so `afterAll` can name them all. */
const written = new Set<string>();

const put = async (prefix: string, label: string) => {
  const payload = bytes(label);
  const { key } = await store.put(prefix, payload, CONTENT_TYPE);
  written.add(key);
  return { key, payload };
};

describe("publicUrl against the live Public Store", () => {
  it("is byte for byte the URL the SDK hands back for the same key", async () => {
    const { key } = await put(PUBLIC_PREFIX, "public url");

    const fromSdk = await blobHead(key, publicAuth());

    expect(store.publicUrl(key)).toBe(fromSdk.url);
  });

  it("serves the identical bytes to a caller holding nothing but the URL", async () => {
    const { key, payload } = await put(PUBLIC_PREFIX, "public bytes");

    const response = await fetch(store.publicUrl(key));

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
  });
});

describe("the wall around the live Private Store", () => {
  it("refuses an unauthenticated GET of a private object's own URL", async () => {
    const { key } = await put(PRIVATE_PREFIX, "the wall");
    // The object's real URL, taken from a Signed URL that does serve it, so
    // this cannot pass by naming a host that never existed.
    const plain = withoutSignature(await store.signedUrl(key));

    const response = await fetch(plain);

    expect(response.status).not.toBe(200);
    // Reported, so the PR can quote what the store actually answered rather
    // than what this test hoped for.
    console.log(
      `unauthenticated GET ${plain} → ${response.status} ${response.statusText} ${JSON.stringify(await response.text())}`
    );
  });

  it("serves the identical bytes through a Signed URL for that same object", async () => {
    const { key, payload } = await put(PRIVATE_PREFIX, "signed bytes");

    const response = await fetch(await store.signedUrl(key));

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
  });

  it("stops serving through a Signed URL once its seconds are up", async () => {
    const { key } = await put(PRIVATE_PREFIX, "expired");
    const url = await store.signedUrl(key, { expiresInSeconds: 1 });

    await new Promise((resolve) => setTimeout(resolve, 3000));
    const response = await fetch(url);

    // The cap of MAX_SIGNED_URL_SECONDS cannot be waited out inside the live
    // suite's budget, so the shortest lifetime the interface allows is what
    // proves an expiry is honoured at all.
    expect(response.status).not.toBe(200);
  });
});

afterAll(async () => {
  await Promise.all([...written].map((key) => store.delete(key)));
});
