/**
 * The Annotation of a Source Image, from the cache or from models: the stage
 * every pipeline Call kind shares (spec, "The pipeline").
 *
 * `annotations.get(hash)` answers when the row is complete for the whole
 * Catalogue; anything else — no row, or a row an older or narrower Catalogue
 * wrote — is one `models.annotate` over every Model, then the File, the
 * Annotation and this Brand's Source Hold are written. The whole Catalogue on
 * every first sight, so one Annotation per photograph serves every consumer
 * (ADR-0014, Decision 3).
 */
import { type Annotation, type ModelId, isComplete } from "@meco/contracts";
import {
  type AnnotateSource,
  ModelsError,
  type ModelsClient,
} from "@meco/models";
import type { Records } from "@meco/records";
import { MAX_SIGNED_URL_SECONDS, type Store } from "@meco/store";
import { modelsUnbound } from "./catalogue";
import type { ResolvedSource } from "./source";
import type { Trace } from "./trace";

/**
 * How long the Signed URL that carries a Source Image to models lives: the
 * store's own ceiling, because the URL is minted for one `POST /annotate` and
 * nothing else holds it. That call is a fetch, one decode and every Model in
 * the Catalogue, and on a cold instance it also waits on three session
 * creates — 4.0 s measured on preview `meco-3giklictc`, 6 Sep 2026, for the
 * 5.4 MB crew portrait. The ceiling is what the store will grant, so naming
 * it here rather than repeating its number keeps the two from parting.
 */
const SOURCE_URL_SECONDS = MAX_SIGNED_URL_SECONDS;

export interface AnnotateDeps {
  readonly records: Records;
  readonly store: Store;
  readonly models: ModelsClient | null;
  /** The Models the cache must be complete for; rejects until models answered. */
  catalogue(): Promise<readonly ModelId[]>;
}

/**
 * What a `source_unfetchable` from models actually means, decided by asking
 * the store once — on the failure path only, so the call that works still
 * touches the object no more than the models host does.
 *
 * Two very different things wear that one code. If the object is still there,
 * the Signed URL itself failed: expired in flight, or Blob refused it, and
 * calling again against a URL the next call mints fresh is the remedy — the
 * error travels on as models' own, which the wire answers 503. If the object
 * is gone while records still names it, no retry can ever succeed: that is
 * the same broken invariant `resolveSource` raises when it reads bytes that
 * are held and not stored, and it must not be dressed up as transient.
 */
async function diagnosed(
  deps: AnnotateDeps,
  key: string,
  hash: string,
  failure: unknown
): Promise<unknown> {
  if (!(failure instanceof ModelsError) || failure.code !== "source_unfetchable") {
    return failure;
  }
  const stored = await deps.store.head(key);
  if (stored !== null) return failure;
  return new Error(`the bytes of ${hash} are held and not stored`, {
    cause: failure,
  });
}

export async function annotationOf(
  deps: AnnotateDeps,
  brand: string,
  source: ResolvedSource,
  trace: Trace
): Promise<Annotation> {
  const { hash } = source;
  const catalogue = await deps.catalogue();

  const cached = await trace.step("records.annotations.get", () =>
    deps.records.annotations.get(hash)
  );
  let annotation: Annotation;
  if (cached !== null && isComplete(cached, [...catalogue])) {
    annotation = cached;
  } else {
    const models = deps.models;
    if (models === null) throw modelsUnbound();

    // Which carrier, decided by where the bytes are rather than by their size.
    // Already filed: a Signed URL, so the photograph crosses the binding once
    // and at any size — bytes in the body meet the platform's 4.5 MB limit,
    // measured on #201. Only in this process: the bytes, which are already
    // here and cannot be filed until models has named the media type.
    const key = await source.storeKey();
    const carrier: AnnotateSource =
      key === null
        ? await source.bytes()
        : {
            url: await trace.step("store.signedUrl", () =>
              deps.store.signedUrl(key, {
                expiresInSeconds: SOURCE_URL_SECONDS,
              })
            ),
          };

    const { annotation: fresh, serverTiming } = await trace.step(
      "models.annotate",
      () => models.annotateTimed(carrier, { hash })
    ).catch(async (failure: unknown) => {
      throw key === null ? failure : await diagnosed(deps, key, hash, failure);
    });
    for (const { name, durMs } of serverTiming) {
      trace.add({ name: `models.${name}`, durMs });
    }
    annotation = fresh;

    // The File after the Annotation, because its width, height and mime are
    // what the decoder read off the bytes. Bytes models refused are never
    // filed. Nothing to file when the carrier was a URL: those bytes are in
    // the store already and their File row is what the key was read from, and
    // `files.ensure` is `onConflictDoNothing`, so it could add nothing.
    if (key === null) {
      // Already in hand and memoised by the resolver, so this is the same
      // read the carrier made and not a second one.
      const bytes = await source.bytes();
      const put = await trace.step("store.put", () =>
        deps.store.put("sources", bytes, annotation.mime)
      );
      await trace.step("records.files.ensure", () =>
        deps.records.files.ensure({
          hash,
          mime: annotation.mime,
          width: annotation.width,
          height: annotation.height,
          bytes: bytes.byteLength,
          storeKey: put.key,
        })
      );
    }
    await trace.step("records.annotations.put", () =>
      deps.records.annotations.put(annotation)
    );
  }

  // Idempotent, and on every path: a `{ hash }` reference already holds, a
  // `{ url }` of a photograph another Brand filed does not yet.
  await trace.step("records.sources.hold", () =>
    deps.records.sources.hold(brand, hash)
  );
  return annotation;
}
