/**
 * One list of Conformance Checks, run against every adapter. `memoryStore()`
 * runs it inside `pnpm check`; `blobStore()` runs the identical list against
 * the live `fra1` stores under `pnpm test:store:live`. A difference between the
 * two adapters is then a red test rather than a production surprise.
 *
 * A check reports failure by throwing, so the assertions are `node:assert`'s
 * and not a test runner's: the list has to survive being handed to whatever
 * runner a consuming package uses.
 */
import {
  deepStrictEqual,
  notStrictEqual,
  ok,
  rejects,
  strictEqual,
  throws,
} from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Check } from "@meco/contracts/conformance";
import type { PutResult, Store } from "./blob";
import { MAX_OBJECT_BYTES, isPrivate } from "./keys";
import { MAX_SIGNED_URL_SECONDS } from "./urls";

/** What an adapter's host hands {@link storeConformance}. */
export interface StoreFixtures {
  /**
   * The prefix every writing check files under. Its Namespace decides which of
   * the two stores is exercised.
   *
   * On a live backend this must be run-scoped — `people/<brand>/<a fresh id>` —
   * because two runs sharing a prefix would share Store Keys, and the dedupe
   * check would then see another run's write as its own.
   */
  readonly prefix: string;
  /**
   * Called with every Store Key a check writes. A live run collects them and
   * deletes them afterwards; the in-memory run has nothing to clean up and
   * leaves this unset.
   */
  readonly wrote?: (key: string) => void;
  /**
   * How long this backend may go on serving an object after it was deleted.
   *
   * Left unset the deletion check reads once, which is the strict version and
   * the only one that catches a regression in an immediately consistent
   * adapter. Blob sets it: its reads go through a CDN, so a single immediate
   * read there asserts a promise the backend never made — which is how
   * [#22](https://github.com/timschoch/meco/issues/22) became flaky. The
   * check's own name states whatever deadline it was given.
   */
  readonly deleteDeadlineMs?: number;
}

/** Every payload is a PNG by declaration; no adapter looks at the bytes. */
const CONTENT_TYPE = "image/png";

/**
 * Distinct bytes per check, so one check's write is never another's dedupe.
 * They are not a real image on purpose: a store that needed them to be one
 * would be decoding, which is `models`' job and not the store's.
 */
const payload = (label: string): Uint8Array =>
  new TextEncoder().encode(`@meco/store conformance: ${label}`);

/**
 * The expected hash, computed here rather than imported, so the assertion
 * cannot agree with the code by construction.
 */
const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** How often the deletion check looks again while it still has a deadline. */
const POLL_INTERVAL_MS = 500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The deadline as the check's name says it, so the two never drift apart. */
const deadlineLabel = (ms: number): string => `${Math.round(ms / 1000)} s`;

export function storeConformance(
  store: Store,
  fixtures: StoreFixtures
): Check[] {
  const { prefix, wrote, deleteDeadlineMs } = fixtures;

  /** Writes under a given prefix, and says what key it left behind. */
  const putAt = async (
    where: string,
    bytes: Uint8Array
  ): Promise<PutResult> => {
    const result = await store.put(where, bytes, CONTENT_TYPE);
    wrote?.(result.key);
    return result;
  };

  /** The fixture's own prefix, which is where all but one check writes. */
  const put = (bytes: Uint8Array): Promise<PutResult> => putAt(prefix, bytes);

  /** What still names the key and how, or `null` once nothing does. */
  const whatStillNames = async (key: string): Promise<string | null> => {
    if ((await store.get(key)) !== null) {
      return `get still hands back "${key}" after it was deleted`;
    }
    const named = (await store.list(prefix)).some((one) => one.key === key);
    return named ? `list("${prefix}") still names "${key}"` : null;
  };

  /**
   * One pass with no deadline, so an immediately consistent adapter is held to
   * a single read; otherwise look again until the deadline passes.
   */
  const gone = async (key: string): Promise<void> => {
    const deadline = Date.now() + (deleteDeadlineMs ?? 0);
    for (;;) {
      const problem = await whatStillNames(key);
      if (problem === null) return;
      if (Date.now() >= deadline) throw new Error(problem);
      await sleep(POLL_INTERVAL_MS);
    }
  };

  return [
    {
      name: "put files the bytes under their own full sha256",
      async run() {
        const bytes = payload("full sha256");
        const written = await put(bytes);

        strictEqual(written.hash, sha256(bytes));
        strictEqual(written.key, `${prefix}/${sha256(bytes)}.png`);
      },
    },
    {
      name: "get hands back the identical bytes",
      async run() {
        const bytes = payload("identical bytes");
        const { key } = await put(bytes);

        const readBack = await store.get(key);

        ok(readBack !== null, `the key "${key}" just written reads as missing`);
        deepStrictEqual([...readBack], [...bytes]);
      },
    },
    {
      name: "writing the same bytes twice writes once and reports deduped",
      async run() {
        const bytes = payload("written twice");

        const first = await put(bytes);
        const second = await put(bytes);

        strictEqual(second.key, first.key);
        strictEqual(first.deduped, false);
        strictEqual(second.deduped, true);
        strictEqual(second.size, bytes.byteLength);
      },
    },
    {
      name: "writing different bytes under one prefix gives different keys",
      async run() {
        const first = await put(payload("different bytes, one"));
        const second = await put(payload("different bytes, two"));

        notStrictEqual(second.key, first.key);
      },
    },
    {
      name: "the store owns its bytes, in and out",
      async run() {
        const bytes = payload("owned bytes");
        const original = [...bytes];

        const { key } = await put(bytes);
        // A caller reusing its buffer must not rewrite what it already stored.
        bytes.fill(0);
        const readBack = await store.get(key);
        ok(readBack !== null, `the key "${key}" just written reads as missing`);
        deepStrictEqual([...readBack], original);

        // And a reader must not be able to edit the store by writing into what
        // it was handed.
        readBack.fill(0);
        const readAgain = await store.get(key);
        ok(
          readAgain !== null,
          `the key "${key}" reads as missing on a re-read`
        );
        deepStrictEqual([...readAgain], original);
      },
    },
    {
      name: "get of a key never written is null, not a throw",
      async run() {
        const missing = `${prefix}/${"0".repeat(64)}.png`;

        strictEqual(await store.get(missing), null);
      },
    },
    {
      name: "head of a missing key is null and of a present key reports the stored size",
      async run() {
        const bytes = payload("head");
        const { key } = await put(bytes);

        const found = await store.head(key);

        ok(found !== null, `the key "${key}" just written heads as missing`);
        strictEqual(found.key, key);
        // The size of what is stored, never the size the caller had in hand.
        strictEqual(found.size, bytes.byteLength);
        strictEqual(found.contentType, CONTENT_TYPE);

        const missing = `${prefix}/${"0".repeat(64)}.png`;
        strictEqual(await store.head(missing), null);
      },
    },
    {
      name:
        deleteDeadlineMs === undefined
          ? "after delete, get is null and list no longer names the key"
          : `after delete, get is null and list no longer names the key, within ${deadlineLabel(deleteDeadlineMs)}`,
      async run() {
        const bytes = payload("deleted");
        const { key } = await put(bytes);

        // Proved present first, so a delete that never had anything to remove
        // cannot pass this check by accident.
        ok(
          (await store.get(key)) !== null,
          `the key "${key}" just written reads as missing`
        );
        ok(
          (await store.list(prefix)).some((one) => one.key === key),
          `list("${prefix}") does not name "${key}" before the delete`
        );

        await store.delete(key);

        await gone(key);
      },
    },
    {
      name: "deleting a key that is already gone is not an error",
      async run() {
        const never = `${prefix}/${"1".repeat(64)}.png`;

        // Twice: a retry and a cascade that runs a second time are the two
        // ways this happens, and neither may throw.
        await store.delete(never);
        await store.delete(never);
      },
    },
    {
      name: "list names every key under the prefix with its size, however many pages that takes",
      async run() {
        const written = new Map<string, number>();
        for (const label of ["listed one", "listed two", "listed three"]) {
          const bytes = payload(label);
          const { key } = await put(bytes);
          written.set(key, bytes.byteLength);
        }

        const listed = new Map(
          (await store.list(prefix)).map((one) => [one.key, one])
        );

        for (const [key, size] of written) {
          const one = listed.get(key);
          ok(one !== undefined, `list("${prefix}") does not name "${key}"`);
          strictEqual(one.size, size);
          ok(
            !Number.isNaN(Date.parse(one.createdAt)),
            `"${one.createdAt}" is no date`
          );
        }
      },
    },
    {
      name: "list names a subtree, so a prefix never matches half a segment",
      async run() {
        // `${prefix}-sibling` shares every character of the prefix but ends a
        // segment elsewhere. Under a raw string match `people/laica/p_1` would
        // name `people/laica/p_10/…`, and a cascade delete would prove itself
        // against another Person's objects.
        const sibling = `${prefix}-sibling`;
        const { key } = await putAt(sibling, payload("sibling subtree"));

        const listed = await store.list(prefix);

        ok(
          !listed.some((one) => one.key === key),
          `list("${prefix}") names "${key}", which is outside it`
        );
        ok(
          (await store.list(sibling)).some((one) => one.key === key),
          `list("${sibling}") does not name its own "${key}"`
        );
      },
    },
    {
      name: "list hands its objects back ordered by key",
      async run() {
        // Promised rather than incidental: a `Map` yields insertion order and a
        // backend yields its own, so an unordered `list` is a difference
        // between the two adapters that a caller would find in production.
        await put(payload("ordered one"));
        await put(payload("ordered two"));

        const listed = await store.list(prefix);

        ok(listed.length > 1, `list("${prefix}") named ${listed.length}`);
        for (let i = 1; i < listed.length; i += 1) {
          ok(
            listed[i - 1]!.key < listed[i]!.key,
            `list("${prefix}") names "${listed[i - 1]!.key}" before "${listed[i]!.key}"`
          );
        }
      },
    },
    {
      name: "a key with `..`, an empty segment or a leading slash is refused",
      async run() {
        // Refused before a call is made, so this costs a live run nothing.
        const bytes = payload("refused key");
        await rejects(
          () => store.put("sources/../people", bytes, CONTENT_TYPE),
          /\.\./
        );
        await rejects(
          () => store.put("people//p_1", bytes, CONTENT_TYPE),
          /empty/i
        );
        await rejects(
          () => store.put("/sources", bytes, CONTENT_TYPE),
          /leading/i
        );
        await rejects(
          () => store.put("uploads", bytes, CONTENT_TYPE),
          /Namespace/
        );
        await rejects(() => store.get("people/../renders/a.png"), /\.\./);

        // Every verb that takes a key, not only the two that carry bytes.
        await rejects(() => store.head("people/../renders/a.png"), /\.\./);
        await rejects(() => store.delete("people/../renders/a.png"), /\.\./);
        await rejects(() => store.list("uploads"), /Namespace/);
      },
    },
    {
      name: "bytes over MAX_OBJECT_BYTES are refused, with the size in the message",
      async run() {
        const tooBig = new Uint8Array(MAX_OBJECT_BYTES + 1);

        await rejects(
          () => store.put(prefix, tooBig, CONTENT_TYPE),
          new RegExp(String(MAX_OBJECT_BYTES + 1))
        );
      },
    },
    {
      name: "an unmapped content type is refused rather than guessed",
      async run() {
        await rejects(
          () => store.put(prefix, payload("text"), "text/plain"),
          /text\/plain/
        );
      },
    },
    {
      name: "isPrivate matches the whole Namespace, case-insensitively",
      async run() {
        ok(isPrivate("people/laica/p_1/a.jpg"));
        ok(isPrivate("People/laica/p_1/a.jpg"));
        ok(isPrivate("SOURCES/a.jpg"));
        ok(!isPrivate("peoples-choice/a.jpg"));
        ok(!isPrivate("renders/a.jpg"));
      },
    },
    {
      name: "isPrivate sends health to the Private Store and health-public to the Public Store",
      async run() {
        ok(isPrivate("health/a.png"));
        ok(!isPrivate("health-public/a.png"));
      },
    },
    {
      name: "publicUrl names a public key under the store's own base URL",
      async run() {
        const key = `crops/${"a".repeat(64)}.png`;

        const url = new URL(store.publicUrl(key));

        strictEqual(url.protocol, "https:");
        // The key verbatim, so a caller that has the key has the URL and
        // nothing has to store one beside the other.
        strictEqual(url.pathname, `/${key}`);
        strictEqual(url.search, "");
        // Arithmetic on one base, not a lookup per key: two keys of the same
        // store differ in their path and in nothing else.
        strictEqual(
          new URL(store.publicUrl(`renders/${"b".repeat(64)}.png`)).origin,
          url.origin
        );
      },
    },
    {
      name: "publicUrl refuses a private key, naming it",
      async run() {
        // A private key has no such URL, and returning one would be a lie a
        // caller could publish.
        for (const key of [
          `people/laica/p_1/${"c".repeat(64)}.jpg`,
          `sources/${"d".repeat(64)}.jpg`,
          `health/${"e".repeat(64)}.png`,
        ]) {
          throws(() => store.publicUrl(key), new RegExp(key));
        }
      },
    },
    {
      name: "signedUrl refuses a public key",
      async run() {
        // The Public Store serves its objects at an address that does not
        // expire, so a signature there would only shorten a URL meant to last.
        for (const key of [
          `renders/${"a".repeat(64)}.png`,
          `crops/${"b".repeat(64)}.png`,
          `health-public/${"c".repeat(64)}.png`,
        ]) {
          await rejects(() => store.signedUrl(key), new RegExp(key));
        }
      },
    },
    {
      name: `signedUrl refuses longer than ${MAX_SIGNED_URL_SECONDS} seconds, and refuses a lifetime that is no lifetime`,
      async run() {
        const key = `people/laica/p_1/${"a".repeat(64)}.jpg`;

        await rejects(
          () =>
            store.signedUrl(key, {
              expiresInSeconds: MAX_SIGNED_URL_SECONDS + 1,
            }),
          new RegExp(String(MAX_SIGNED_URL_SECONDS))
        );
        await rejects(() => store.signedUrl(key, { expiresInSeconds: 0 }), /0/);
        await rejects(
          () => store.signedUrl(key, { expiresInSeconds: -60 }),
          /-60/
        );
        await rejects(
          () => store.signedUrl(key, { expiresInSeconds: 1.5 }),
          /1\.5/
        );
      },
    },
    {
      name: "signedUrl names the private key it was minted for and carries what makes it expire",
      async run() {
        const { key } = await put(payload("signed url"));

        const url = new URL(
          await store.signedUrl(key, { expiresInSeconds: 60 })
        );

        strictEqual(url.protocol, "https:");
        strictEqual(url.pathname, `/${key}`);
        // A Signed URL with no query is the plain private URL, which is the
        // one thing it must never be: that URL is the wall.
        ok(url.search !== "", `the Signed URL for "${key}" carries no query`);
      },
    },
    {
      name: "uploadUrl names the key put would have written the same bytes to",
      async run() {
        // The whole point of minting a key from the hash alone: an upload the
        // client sends straight to the backend has to land exactly where the
        // deployment's own write would have put it, or the Content Hash stops
        // being the address and every dedupe below is a coincidence.
        // Nothing is written: the first check above already fixes what key
        // `put` gives these bytes, so asserting the same key here is what
        // makes the two agree, and a mint that wrote an object would be a
        // mint with a side effect.
        const bytes = payload("upload url");

        const target = await store.uploadUrl(
          prefix,
          sha256(bytes),
          CONTENT_TYPE
        );

        strictEqual(target.key, `${prefix}/${sha256(bytes)}.png`);
        const url = new URL(target.url);
        strictEqual(url.protocol, "https:");
        ok(
          url.search !== "",
          `the upload URL for "${target.key}" carries no query`
        );
        ok(
          Date.parse(target.expiresAt) > Date.now(),
          `the upload URL for "${target.key}" expires at ${target.expiresAt}, which is not ahead`
        );
        strictEqual(target.maxBytes, MAX_OBJECT_BYTES);
      },
    },
    {
      name: "uploadUrl refuses a public prefix",
      async run() {
        // Nobody uploads a Render: the Public Store holds what the deployment
        // made, and a URL that took bytes in there would take them from anyone.
        for (const where of ["renders", "crops", "health-public"]) {
          await rejects(
            () => store.uploadUrl(where, "a".repeat(64), CONTENT_TYPE),
            new RegExp(where)
          );
        }
      },
    },
    {
      name: "uploadUrl refuses a hash that is no Content Hash, and a size that is no size",
      async run() {
        const where = "people/laica/p_1";

        for (const hash of ["", "abc", "A".repeat(64), "g".repeat(64)]) {
          await rejects(() => store.uploadUrl(where, hash, CONTENT_TYPE));
        }
        const hash = "a".repeat(64);
        await rejects(
          () =>
            store.uploadUrl(where, hash, CONTENT_TYPE, {
              maxBytes: MAX_OBJECT_BYTES + 1,
            }),
          new RegExp(String(MAX_OBJECT_BYTES))
        );
        await rejects(
          () => store.uploadUrl(where, hash, CONTENT_TYPE, { maxBytes: 0 }),
          /0/
        );
        await rejects(
          () =>
            store.uploadUrl(where, hash, CONTENT_TYPE, { maxBytes: 1024.5 }),
          /1024\.5/
        );
        await rejects(() => store.uploadUrl(where, hash, "image/gif"), /gif/);
      },
    },
  ];
}
