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
import type { ModelsClient } from "@meco/models";
import type { Records } from "@meco/records";
import type { Store } from "@meco/store";
import { modelsUnbound } from "./catalogue";
import type { ResolvedSource } from "./source";
import type { Trace } from "./trace";

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
    const bytes = await source.bytes();
    const { annotation: fresh, serverTiming } = await trace.step(
      "models.annotate",
      () => models.annotateTimed(bytes, { hash })
    );
    for (const { name, durMs } of serverTiming) {
      trace.add({ name: `models.${name}`, durMs });
    }
    annotation = fresh;

    // The File after the Annotation, because its width, height and mime are
    // what the decoder read off the bytes. Bytes models refused are never
    // filed.
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
