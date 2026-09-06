/**
 * The Gallery: the Caller's Outputs newest first, as a grid of cards.
 *
 * Every card is the whole image at its Public URL, because Blob has no
 * transform on the read path and a module that resized would touch pixels,
 * which webui may not. A Render measures 0.7 to 2.5 MB PNG (compose goldens,
 * `packages/compose/tests/goldens`, seven files, 6 Sep 2026), so the page is
 * kept short and every image is deferred.
 */
import type { Brand, Output, OutputKind } from "@meco/records";
import type { Store } from "@meco/store";
import { Layout } from "./layout";
import { KINDS, type Filterable, type GalleryQuery, linkTo } from "./query";

export interface GalleryProps {
  readonly basePath: string;
  readonly query: GalleryQuery;
  readonly outputs: readonly Output[];
  /** The Caller's Brands, for the filter links. Names come from records. */
  readonly brands: readonly Brand[];
  readonly store: Pick<Store, "publicUrl">;
  readonly cursor: string | null;
}

/** The Placements the page can offer, taken from what is on it. */
const placementsOf = (outputs: readonly Output[]): string[] =>
  [
    ...new Set(
      outputs
        .map((one) => one.placement)
        .filter((one): one is string => one !== null)
    ),
  ].sort();

function Filter(props: {
  basePath: string;
  query: GalleryQuery;
  heading: string;
  field: Filterable;
  options: readonly { value: string; label: string }[];
}) {
  const selected = props.query[props.field];
  return (
    <section>
      <h2>{props.heading}</h2>
      <a
        href={linkTo(props.basePath, props.query, { field: props.field })}
        aria-current={selected === undefined ? "true" : "false"}
      >
        all
      </a>
      {props.options.map((option) => (
        <a
          href={linkTo(props.basePath, props.query, {
            field: props.field,
            value: option.value,
          })}
          aria-current={selected === option.value ? "true" : "false"}
        >
          {option.label}
        </a>
      ))}
    </section>
  );
}

function Card(props: {
  basePath: string;
  output: Output;
  store: Pick<Store, "publicUrl">;
}) {
  const { output } = props;
  return (
    <a class="card" href={`${props.basePath}/calls/${output.callId}`}>
      <img
        src={props.store.publicUrl(output.storeKey)}
        alt={`${output.kind} for ${output.brand}`}
        loading="lazy"
        decoding="async"
      />
      <dl>
        <dt>kind</dt>
        <dd>{output.kind}</dd>
        <dt>placement</dt>
        <dd>{output.placement ?? "—"}</dd>
        <dt>brand</dt>
        <dd>{output.brand}</dd>
        <dt>made</dt>
        <dd>
          <time datetime={output.createdAt}>{output.createdAt}</time>
        </dd>
        <dt>call</dt>
        <dd>{output.status}</dd>
      </dl>
    </a>
  );
}

export function Gallery(props: GalleryProps) {
  const placements = placementsOf(props.outputs);
  return (
    <Layout title="meco — Gallery">
      <h1>Gallery</h1>
      <nav>
        <Filter
          basePath={props.basePath}
          query={props.query}
          heading="brand"
          field="brand"
          options={props.brands.map((one) => ({
            value: one.id,
            label: one.name,
          }))}
        />
        {placements.length === 0 ? null : (
          <Filter
            basePath={props.basePath}
            query={props.query}
            heading="placement"
            field="placement"
            options={placements.map((one) => ({ value: one, label: one }))}
          />
        )}
        <Filter
          basePath={props.basePath}
          query={props.query}
          heading="kind"
          field="kind"
          options={KINDS.map((one: OutputKind) => ({ value: one, label: one }))}
        />
      </nav>

      {props.outputs.length === 0 ? (
        <p class="empty">Nothing here yet.</p>
      ) : (
        <div class="grid">
          {props.outputs.map((output) => (
            <Card
              basePath={props.basePath}
              output={output}
              store={props.store}
            />
          ))}
        </div>
      )}

      {props.cursor === null ? null : (
        <a
          class="older"
          href={linkTo(props.basePath, props.query, { cursor: props.cursor })}
        >
          older →
        </a>
      )}
    </Layout>
  );
}
