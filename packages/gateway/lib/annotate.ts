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
import type { AnnotateSource, ModelsClient } from "@meco/models";
import type { Records } from "@meco/records";
import type { Store } from "@meco/store";
import { modelsUnbound } from "./catalogue";
import type { ResolvedSource } from "./source";
import type { Trace } from "./trace";

/**
 * How long the Signed URL that carries a Source Image to models lives. Short
 * because it need only outlive one `POST /annotate`, which on the deployed
 * container is a fetch, one decode and every Model in the Catalogue; well
 * under the store's own `MAX_SIGNED_URL_SECONDS` ceiling of 300.
 */
const SOURCE_URL_SECONDS = 300;

export interface AnnotateDeps {
  readonly records: Records;
  readonly store: Store;
  readonly models: ModelsClient | null;
  /** The Models the cache must be complete for; rejects until models answered. */
  catalogue(): Promise<readonly ModelId[]>;
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
    let bytes: Uint8Array | null = null;
    let carrier: AnnotateSource;
    if (key === null) {
      bytes = await source.bytes();
      carrier = bytes;
    } else {
      carrier = {
        url: await trace.step("store.signedUrl", () =>
          deps.store.signedUrl(key, { expiresInSeconds: SOURCE_URL_SECONDS })
        ),
      };
    }

    const { annotation: fresh, serverTiming } = await trace.step(
      "models.annotate",
      () => models.annotateTimed(carrier, { hash })
    );
    for (const { name, durMs } of serverTiming) {
      trace.add({ name: `models.${name}`, durMs });
    }
    annotation = fresh;

    // The File after the Annotation, because its width, height and mime are
    // what the decoder read off the bytes. Bytes models refused are never
    // filed. Nothing to file when the carrier was a URL: those bytes are in
    // the store already and their File row is what the key was read from, and
    // `files.ensure` is `onConflictDoNothing`, so it could add nothing.
    if (bytes !== null) {
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
