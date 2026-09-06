# Spec: the store module

Parent: [Module: store (#81)](https://github.com/timschoch/meco/issues/81). Reasons: [ADR-0010](../adr/0010-store-vercel-blob-in-the-eu-two-stores.md). Vocabulary: [`CONTEXT.md`, store](../../CONTEXT.md#store). Package layout: [`packages/README.md`](../../packages/README.md). Infra: [#98](https://github.com/timschoch/meco/issues/98), [`DEPLOY.md`](../../DEPLOY.md).

## Problem statement

Every other module needs somewhere to put bytes and get them back. Some of those bytes are a finished image anyone may fetch at a permanent URL; some are a photograph of a named person that no URL may hand over. If each module decides for itself which is which, one of them eventually gets it wrong, and the failure is a face photo on an open URL rather than an exception.

## Solution

One package, `@meco/store`, holding bytes under a Store Key. The Namespace of the key decides whether the object lands in the Public Store or the Private Store, so no caller chooses. Two adapters — Vercel Blob and in-memory — sit behind one interface and pass the same Conformance Checks.

The store knows what a key is and which store it belongs to. It does not know what the bytes depict, who may see them, or whether anything still points at them. Those are `models`, `gateway` and `records` respectively.

## User stories

1. As the gateway, I want to hand the store bytes and a prefix and get a key back, so that I never compute a hash or choose a store myself.
2. As `records`, I want the store to return the Content Hash of what it just wrote, so that my row and the Annotation under that hash agree by construction, not because two call sites both remembered sha256.
3. As `records`, I want to store a key and derive the URL, so that nothing breaks the day a store is recreated in another region.
4. As `identify`, I want to read a Reference Photo inside the deployment, so that re-embedding never puts the bytes on the internet.
5. As the gateway, I want a Signed URL for one private object valid for minutes, so that an authorised caller can see a Reference Photo without it becoming a link that outlives the request.
6. As `records`, I want deletion of a Person's Reference Photos to be provable, so that a cascade that leaves personal data behind fails a test instead of passing one.
7. As any module author, I want one suite run against both adapters, so that a difference between them is caught by a test rather than discovered in production.
8. As a developer with no network, I want the in-memory adapter behind the identical interface, so that a test never reaches `fra1`.
9. As the owner, I want a write to the Private Store to fail loudly when no private store is configured, so that a Reference Photo can never quietly land in the Public Store.

## Implementation decisions

### The exported surface

```ts
// packages/store/index.ts
export const NAMESPACES: readonly [
  "sources",
  "renders",
  "crops",
  "people",
  "health",
  "health-public",
];
export type Namespace = (typeof NAMESPACES)[number];
export const MAX_OBJECT_BYTES: 33_554_432; // 32 MiB
export const MAX_SIGNED_URL_SECONDS: 300;

export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
}
export interface PutResult extends StoredObject {
  hash: string;
  deduped: boolean;
}
export interface Listing {
  key: string;
  size: number;
  createdAt: string;
}

export interface Store {
  put(
    prefix: string,
    bytes: Uint8Array,
    contentType: string
  ): Promise<PutResult>;
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<Listing[]>;
  publicUrl(key: string): string;
  signedUrl(
    key: string,
    options?: { expiresInSeconds?: number }
  ): Promise<string>;
}

export function isPrivate(key: string): boolean;
export function blobStore(config?: BlobStoreConfig): Store;
export function memoryStore(): Store;

// packages/store/conformance.ts
export interface Check {
  name: string;
  run(): Promise<void>;
}
export function storeConformance(store: Store, options: StoreFixtures): Check[];
```

Two root files, as `contracts` does: the runtime surface and the checks, so fixture handling stays out of the runtime graph.

### One write verb

`put(prefix, bytes, contentType)` hashes the bytes, appends `<sha256>.<ext>` to the prefix, `head`s the result, and writes only if it is not already there. It returns the key, the hash, the size and whether the write was skipped.

**Every Store Key ends in the Content Hash of its own bytes, so nothing is ever overwritten.** Different bytes are a different key; the same bytes are the same write. That removes `allowOverwrite` from the interface, removes a partly-written key from the set of things a reader can observe, and confines Blob's 60-second propagation window to deletion alone.

The prototype had a second, overwriting verb (`putAt`) because it had no database and records lived in the store. `records` is that database now, and it is where "which bytes are current" belongs. Mutability is a row, not a key.

`head` before write is also the cheap direction: a simple operation is $0.40 per million against $5.00 for an advanced one on Vercel's rate card, read 6 Sep 2026.

### Keys

| Prefix passed to `put`      | Store Key                                  | store   | shared across Brands |
| --------------------------- | ------------------------------------------ | ------- | -------------------- |
| `sources`                   | `sources/<sha256>.<ext>`                   | private | yes                  |
| `renders`                   | `renders/<sha256>.<ext>`                   | public  | yes                  |
| `crops`                     | `crops/<sha256>.<ext>`                     | public  | yes                  |
| `people/<brand>/<personId>` | `people/<brand>/<personId>/<sha256>.<ext>` | private | no                   |
| `health`                    | `health/<sha256>.<ext>`                    | private | yes                  |
| `health-public`             | `health-public/<sha256>.<ext>`             | public  | yes                  |

- `<sha256>` is 64 lowercase hex characters, the same string `contracts` fixes as the Annotation's key — not the prototype's 32-character truncation.
- `<ext>` is derived from `contentType` over a closed map: `image/jpeg → jpg`, `image/png → png`, `image/webp → webp`, `application/pdf → pdf`. An unmapped content type is refused, so an extension is never guessed.
- A key is validated before it reaches a backend: non-empty, no leading `/`, no empty or `.` or `..` segment. On any backend a key is a path, and `..` is how a path leaves the store it was supposed to be inside.
- `health` and `health-public` hold the two probe objects `/health` round-trips and nothing else, one per store, keyed like everything else so a probe writes once and finds itself ever after. They are Namespaces of their own rather than corners of `sources` and `renders` so that a probe never appears in a `list("sources/")` deletion proof or in the Gallery, and so `records` never has to explain a Source Image nothing uploaded. There are two because a Namespace maps to exactly one store, so the two probes cannot share one. Superseding decision on [#81](https://github.com/timschoch/meco/issues/81).
- `isPrivate(key)` is a case-insensitive test on the Namespace. Case-insensitive because that one comparison is what stands between a face photo and an open URL, and `People/…` must not be a way out.

### The two stores

|               | name              | id                       | region |
| ------------- | ----------------- | ------------------------ | ------ |
| Public Store  | `meco-renders-eu` | `store_g8k1dqE6AcEmXk6K` | `fra1` |
| Private Store | `meco-people-eu`  | `store_rNFO9fh833veVEUi` | `fra1` |

`publicUrl(key)` is arithmetic, not a lookup: `https://<store id, lowercased, without the store_ prefix>.public.blob.vercel-storage.com/<key>`. Verified against the live account on 6 Sep 2026 with `vercel blob list`. It throws for a private key, because a private key has no such URL and returning one would be a lie a caller could publish.

`signedUrl(key, { expiresInSeconds })` throws for a public key, defaults to 300 seconds and refuses more. Vercel caps `validUntil` at seven days; meco caps at five minutes, because the only use is showing one private object to the caller who just asked for it.

The Private Store holds two shapes, and they differ in who may see them:

| shape                                      | shared across Brands | who may be given a Signed URL                                          |
| ------------------------------------------ | -------------------- | ---------------------------------------------------------------------- |
| `sources/<sha256>.<ext>`                   | yes                  | a caller whose Brand has a `records` row referencing that Content Hash |
| `people/<brand>/<personId>/<sha256>.<ext>` | no                   | a caller holding that Brand                                            |

The store cannot tell Brands apart and does not try. It refuses everyone without a Signed URL and mints one for anyone the gateway asks on behalf of. Deciding whether this caller's Brand may see this hash is the gateway's, on a `records` row: a Source Image is shared bytes, so the key alone proves nothing about who uploaded it. Carried to [#86](https://github.com/timschoch/meco/issues/86).

### Configuration

| Variable                       | Sensitivity   | Purpose                                               |
| ------------------------------ | ------------- | ----------------------------------------------------- |
| `BLOB_PUBLIC_STORE_ID`         | non-sensitive | which store `publicUrl` and every public call address |
| `BLOB_PRIVATE_STORE_ID`        | non-sensitive | the same, for the Private Store                       |
| `VERCEL_OIDC_TOKEN`            | platform      | preferred credential, rotates itself                  |
| `BLOB_READ_WRITE_TOKEN`        | injected      | fallback for the Public Store                         |
| `BLOB_PEOPLE_READ_WRITE_TOKEN` | injected      | fallback for the Private Store                        |

A store id is not a secret: it is the first label of every public URL the store hands out. The store connections inject the two tokens and no `BLOB_STORE_ID`, which is correct rather than missing — that variable names one store and meco has two, so the SDK takes `storeId` per call.

Credentials resolve per store: `VERCEL_OIDC_TOKEN` when present, else that store's read-write token. **Whether `VERCEL_OIDC_TOKEN` reaches a container runtime at all is unverified** — Vercel documents OIDC for functions and says nothing either way about container services. The first ticket measures it against the deployed gateway and reports which rung carried the round trip.

A missing `BLOB_PRIVATE_STORE_ID` makes every private write and read throw, naming the variable. It never falls back to the Public Store.

### Limits

`MAX_OBJECT_BYTES` is 32 MiB, refused with the actual size in the message rather than truncated. Provenance: [#30](https://github.com/timschoch/meco/issues/30) measured a 12 MP crew portrait at 5 424 279 bytes as the camera original and 3 311 230 at `?width=2400`; phone and camera originals run 5–8 MB. 32 MiB is four times the largest ordinary original and far below Blob's 5 TB ceiling.

Bytes cross the interface as `Uint8Array`, not as a stream. Every consumer needs the whole image resident — `models` decodes it, `frame` measures it, `redact` and `compose` draw on it — so a stream would be collected into a buffer at every call site. Public bytes are served by the Blob CDN and never pass through a container, so there is no pass-through download for streaming to pay for.

Unresolved and inherited: [#30](https://github.com/timschoch/meco/issues/30) found a 4.5 MB request-body cap on the function fronting the prototype's container service. Whether that cap survives under GA `services` is the gateway's question, not the store's. It decides one thing here: whether a large Source Image can reach the store through the gateway, or has to go straight to Blob. Raised on the gateway parent.

### `list` exists to prove deletion

The prototype's `list(prefix)` built the Gallery, because there was no database. `records` owns the Gallery now, so that reason is gone. `list` stays for the other job: proving that a delete left nothing behind. `CLAUDE.md` records that one of the three Subject-aware Crop mutation tests found a cascade-delete test that passed against a version leaving personal data in the store, and enumerating what remains is the only way to catch that. If `webui` ever calls `list`, that is a bug in `webui`.

## Testing decisions

`storeConformance(store, fixtures)` returns named `Check`s that both adapters run. A package's Vitest file maps them: `for (const c of checks) it(c.name, c.run)`.

| Check                                                                               | Mutation that must turn it red                           |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `put` returns a key ending in the sha256 of the bytes                               | truncate the hash to 32 characters, as the prototype did |
| `get` returns the identical bytes                                                   | return the bytes of a different key                      |
| writing the same bytes twice returns the same key and `deduped: true` on the second | drop the `head` check and always write                   |
| writing different bytes to the same prefix returns different keys                   | key on the prefix alone                                  |
| `get` of a key never written is `null`, not a throw                                 | throw on a miss                                          |
| `head` of a missing key is `null`; of a present key reports the true size           | report the requested size instead of the stored one      |
| after `delete`, `get` is `null` and `list(prefix)` no longer names the key          | make `delete` a no-op                                    |
| deleting a key that is already gone is not an error                                 | throw on a missing key                                   |
| a key with `..`, an empty segment or a leading `/` is refused                       | drop the key validation                                  |
| bytes over `MAX_OBJECT_BYTES` are refused, with the size in the message             | drop the size check                                      |
| an unmapped content type is refused                                                 | fall back to a guessed extension                         |
| `isPrivate` is true for `people/…` and `People/…`, false for `peoples-choice/…`     | make the comparison case-sensitive                       |
| `publicUrl` throws for a private key                                                | return a URL for any key                                 |
| `signedUrl` throws for a public key and refuses over 300 seconds                    | drop the cap                                             |
| a private object's plain URL does not serve the bytes unauthenticated               | write a private key to the public store                  |
| with no private store configured, a private write throws naming the variable        | fall back to the Public Store                            |

Two adapters, not three. `memoryStore()` runs the suite inside `pnpm check`, in the gate. `blobStore()` runs the identical suite under `pnpm test:store:live`, out of the gate, against a run-scoped throwaway prefix it deletes in a `finally`. The prototype also had a disk adapter, which existed only because there was no other way to run offline. `vercel env pull` now hands a developer real credentials, and a third adapter is a third thing to keep honest.

The deletion check polls to a deadline on the Blob adapter and reads once on the in-memory one. Blob's reads go through a CDN, and a delete can take up to 60 s to stop being served. So a single immediate read asserts a promise the backend never made, which is how [#22](https://github.com/timschoch/meco/issues/22) became flaky. The in-memory adapter keeps the strict version; weakening it there would hide a regression in the one adapter that is immediately consistent.

The live suite has a budget of **two minutes**, and the ticket reports the measured wall time and what it was measured against. The prototype's took roughly ten and was excluded from the gate for it.

Every check is proved able to fail before it ships, by the mutation named beside it in the table.

## Out of scope

- Deciding who may read an object. The store knows public and private; authorisation is the gateway's, on the caller's Brands ([#77](https://github.com/timschoch/meco/issues/77)).
- Counting references before a delete. `store.delete` is unconditional; raised on [#86](https://github.com/timschoch/meco/issues/86).
- The Gallery, and any listing a person reads. That is `records` and `webui`.
- Anything that touches pixels, decodes, renders or resizes. `putImage` exists in the Blob SDK and is deliberately not used: a store that transforms bytes no longer keeps them.
- Client-side uploads straight to Blob, and multipart. Both wait on the gateway's answer about the ingress cap.
- Retention and lifecycle rules. Nothing expires on its own in v1.

## Further notes

`Content Hash` is `contracts`' term and is not redefined here; the store computes one and files under it. `Stored Object` is wider than `CONTEXT.md`'s "stored output": every Render, Crop, Source Image and Reference Photo is a Stored Object, but only the outputs are in the Gallery.
