# ADR-0010 — Vercel Blob in the EU, two stores, and the key decides which

Status: **accepted, 6 Sep 2026**. Parent: [Module: store (#81)](https://github.com/timschoch/meco/issues/81), under the modular rebuild map [#60](https://github.com/timschoch/meco/issues/60). Infra move: [#98](https://github.com/timschoch/meco/issues/98). Spec: [`../specs/store.md`](../specs/store.md). Vocabulary: [`CONTEXT.md`, store](../../CONTEXT.md#store).

## Context

`store` holds every byte meco has: the photographs it is given, and the images it makes. Some of those bytes are a biometric record of a named person (ADR-0003). Two of the three decisions below cannot be taken twice — a Blob store's region is fixed at creation, and personal data, once written, has to be migrated rather than moved.

The prototype used Vercel Blob with a public store and a second store created `--access private`, and refused a private write when its token was missing. The greenfield rule gives none of that a vote. What follows re-decides it against the field, and lands in the same place for different reasons.

## Decision

### Vercel Blob, re-chosen on three properties

Measured 6 Sep 2026 against Cloudflare R2, AWS S3 and Neon Object Storage, at a plausible v1 scale of 10 GB stored, 100k objects, 50k reads a month and roughly 50 GB egress:

|                       | storage     | operations                         | egress         | per month |
| --------------------- | ----------- | ---------------------------------- | -------------- | --------- |
| Vercel Blob           | $0.023/GB   | $5.00/1M advanced, $0.40/1M simple | $0.05/GB       | ~$3.25    |
| Cloudflare R2         | $0.015/GB   | $4.50/1M A, $0.36/1M B             | none           | ~$0.62    |
| AWS S3 `eu-central-1` | ~$0.0245/GB | ~$0.005/1k PUT                     | ~$0.09/GB      | ~$5.27    |
| Neon Object Storage   | $0.023/GB   | not metered                        | plan allowance | ~$0.23    |

Blob's free grants (5 GB, 10k advanced operations, 100 GB transfer) absorb most of meco's share. **Price is not the discriminator**: the whole field fits inside $5 a month. Three properties are.

1. **No long-lived secret.** Private Blob went GA on 30 Jun 2026 and authenticates on Vercel by OIDC. R2, S3 and Neon each need a static access-key pair in project environment variables. For the module that holds every Reference Photo, that is the difference between a credential that rotates itself and one nobody owns rotating.
2. **Signed URLs are first-party and GA** — `issueSignedToken()` and `presignUrl()`, `validUntil` capped at seven days. R2 and S3 match this through SigV4. Neon Object Storage documents no presigned URLs at all and is public beta with no SLA, which is disqualifying for the module every other module depends on.
3. **Same platform, same region, one bill.** R2 would save about $2.50 a month in egress and cost a second vendor, `@aws-sdk/client-s3`, and a key-rotation story.

### The EU, decided while it was still free

Every home was in the United States: both Blob stores in `iad1`, the Neon project for `records` in `us-east-1`, both containers in `iad1`. meco's consumers are Swiss and EU brands, and a Face Print is a biometric template of a real person.

A Blob store's region is chosen at creation and **cannot be changed**. On 6 Sep 2026 the private store held zero files and the Neon project had no schema, so the move cost a handful of commands; after the first enrolled Person it is a biometric-data migration. That asymmetry is the whole argument, and it is why this was decided with the owner away rather than parked until they returned.

|                                  | region         | id                                     |
| -------------------------------- | -------------- | -------------------------------------- |
| Public Store `meco-renders-eu`   | `fra1`         | `store_g8k1dqE6AcEmXk6K`               |
| Private Store `meco-people-eu`   | `fra1`         | `store_rNFO9fh833veVEUi`               |
| `records` Neon `meco-records-eu` | `eu-central-1` | prefix `RECORDS_`                      |
| both containers                  | `fra1`         | `"regions": ["fra1"]` in `vercel.json` |

The `iad1` stores are disconnected from the project and hold only the prototype's 152 disposable renders. `regions` governing a **container** service is undocumented — Vercel documents the key for functions — and was confirmed by deploying.

### Two stores, and the key decides which

Vercel Blob sets access per _store_, not per object, so "one store, per-object access" does not exist on this backend. Nor does one private store for everything. `CONTEXT.md` requires a Render and a Crop to be reachable at a **stable** URL, and a Signed URL expires within seven days, so it cannot be the URL a caller schedules a post against. Serving every finished image through the gateway instead would put a scale-to-zero container on the read path of every view.

The Namespace of a Store Key picks the store, so no call site can choose wrong by forgetting. A missing Private Store is an error, never a fall back to the Public Store. That one line of the prototype is also the greenfield first choice: it is what makes a leak impossible rather than a code-review item.

| Namespace                                  | store   | shared across Brands |
| ------------------------------------------ | ------- | -------------------- |
| `renders/<sha256>.<ext>`                   | public  | yes                  |
| `crops/<sha256>.<ext>`                     | public  | yes                  |
| `sources/<sha256>.<ext>`                   | private | yes                  |
| `people/<brand>/<personId>/<sha256>.<ext>` | private | no                   |

Outputs are keyed by the hash of the **produced bytes**, not of the request. The store must not know what a FramingRequest is, and "this request already produced that key" is a `records` row, which is where the FramingRequest already lives. No Brand appears in a public key: the bytes are the same bytes whoever made them, and a Brand name in a public URL discloses the customer. Every private key that is not shared carries the Brand, because Brand is the ownership wall ([#63](https://github.com/timschoch/meco/issues/63)) and the prefix is what makes a cascade delete a prefix operation instead of a scan.

### Credentials

The store connections inject `BLOB_READ_WRITE_TOKEN` and `BLOB_PEOPLE_READ_WRITE_TOKEN` and no `BLOB_STORE_ID`. That is not a gap to close: `BLOB_STORE_ID` names one store and meco has two. The SDK takes a `storeId` per call instead.

So the store reads two plain variables, `BLOB_PUBLIC_STORE_ID` and `BLOB_PRIVATE_STORE_ID`. **A store id is not a secret** — it is the first label of every public URL the store hands out — so both go in as non-sensitive. The credential beside them resolves in one order, per store: `VERCEL_OIDC_TOKEN` when present, else that store's injected read-write token.

Whether `VERCEL_OIDC_TOKEN` reaches a **container** runtime, and whether one project-scoped token authorises both connected stores, is documented nowhere either way. It is measured by the first ticket, against the deployed gateway. If OIDC is not available to containers, the read-write token is the answer and this ADR is amended with the measurement; the residency and signed-URL reasons for Blob stand without it.

**Measured, 6 Sep 2026: `VERCEL_OIDC_TOKEN` does not reach a container, so the read-write token is the rung that carries every call.** `GET /health` on preview deployment `dpl_3paWgFYje3P2EQxHgrvzDUQQgj3S` ([#123](https://github.com/timschoch/meco/issues/123)) reported `"credential": "token"` for both stores, and `vercel env ls` lists no `VERCEL_OIDC_TOKEN` on the project in any Environment — the one a developer holds locally is minted by `vercel env pull`. The ladder stays as written, because a function-runtime consumer would still take the first rung and the same code serves both. The consequence is that meco does hold a long-lived secret per store after all, so "no long-lived secret" is a reason for Blob that a container deployment does not yet collect. One project-scoped token per store authorises that store; `storeId` per call is what tells them apart.

## Consequences

**A public URL is arithmetic, so no URL is ever stored.** Measured against the live account on 6 Sep 2026: for store `store_5GPnk9SrmssEyYHH`, `vercel blob list` returns `https://5gpnk9srmsseyyhh.public.blob.vercel-storage.com/<pathname>`. That is the id lowercased with `store_` stripped, then the key verbatim, because `addRandomSuffix` is false. `records` keeps the Store Key and derives the rest. A URL column would have gone stale the day the stores moved to `fra1`.

**Reads go through a CDN, so a delete is not instant.** Vercel documents up to 60 s before an overwrite or a delete stops being served. This is the root cause of [#22](https://github.com/timschoch/meco/issues/22), where the prototype's contract test asserted a promise Blob never made and failed at random. meco does not overwrite at all. Every Store Key ends in the Content Hash of its own bytes, so a second write of the same bytes is the same write, and different bytes are a different key. That leaves the window applying to deletion alone. The store's conformance check for deletion polls to a named deadline. The in-memory adapter keeps the strict single-read version, because weakening it there would hide a regression in the one adapter that _is_ immediately consistent.

**The store is immutable and `records` is where mutability lives.** One write verb, always content-addressed, means `allowOverwrite` never appears and a partly-written key can never be observed. "Which bytes are current" becomes a row rather than a race. The prototype needed a second, overwriting verb because it had no database; `records` is that database now.

Two verbs were decided first — `putContent` for content-addressed writes and `putAt` for a key the caller owns and overwrites, which is the prototype's shape. Writing the interface down narrowed it to one. No v1 caller for `putAt` could be named: Annotations go to Neon, Templates are TSX in code, Brand configuration is not the store's, and a Reference Photo is content-addressed under a prefix like everything else. An unused write verb on the module that holds every Reference Photo is a way to overwrite one by accident later. The narrowing also fixed a flaw in the two-verb shape: `putContent(namespace, …)` cannot express `people/<brand>/<personId>/<sha256>.<ext>`, so under it `records` would have had to compute the hash itself, which is the one thing the store owning the hash was meant to prevent.

**`store.delete(key)` is unconditional.** Two Brands whose Crops come out byte-identical share one key, so whether a key is still referenced is a `records` question, raised on [#86](https://github.com/timschoch/meco/issues/86). Keeping the store ignorant is what keeps it deep; the cost is that `records` can delete bytes another Brand is using if it does not count first.

**A Source Image is private, so `webui` cannot show a "before" thumbnail from a plain URL** and has to ask the gateway for a Signed URL. The photograph is the caller's own, it holds faces of people who consented to nothing, and it is not what the caller asked to publish — the Crop is. The prototype's answer was public, and the cost is measurable: an unauthenticated `curl` of a prototype Annotation returned `200` on 6 Sep 2026, serving face boxes of strangers to anyone with the URL. Unguessable is not private.
