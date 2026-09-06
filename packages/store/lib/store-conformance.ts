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
} from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Check } from "@meco/contracts/conformance";
import type { PutResult, Store } from "./blob";
import { MAX_OBJECT_BYTES, isPrivate } from "./keys";

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

export function storeConformance(
  store: Store,
  fixtures: StoreFixtures
): Check[] {
  const { prefix, wrote } = fixtures;

  /** Writes, and tells the caller what key it left behind. */
  const put = async (bytes: Uint8Array): Promise<PutResult> => {
    const result = await store.put(prefix, bytes, CONTENT_TYPE);
    wrote?.(result.key);
    return result;
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
  ];
}
