/**
 * The Calls list: the Caller's Calls newest first, as a table.
 *
 * A failed Call has no Output, so without this page a failure is a gap in the
 * Gallery rather than something shown ([ADR-0011](../../../docs/adr/0011-records-postgres-rows-counted-deletes-and-a-sweep.md):
 * a failed Call is a row). `?status=failed` is therefore the point of the page
 * and not a convenience, and every failed row names the module and the code so
 * the list answers "what is failing" without opening a Call View.
 */
import type { Brand, Call } from "@meco/records";
import { Layout } from "./layout";
import { Filter, Older, Pages } from "./nav";
import { CALLS_FIELDS, STATUSES, type CallsQuery } from "./query";

export interface CallsProps {
  readonly basePath: string;
  readonly query: CallsQuery;
  readonly calls: readonly Call[];
  /** The Caller's Brands, for the filter links. Names come from records. */
  readonly brands: readonly Brand[];
  readonly cursor: string | null;
}

/** Nothing measured, rather than a zero the gateway never wrote. */
const took = (durationMs: number | null): string =>
  durationMs === null ? "—" : `${durationMs} ms`;

function Row(props: { basePath: string; call: Call }) {
  const { call } = props;
  return (
    <tr>
      <td>
        <a href={`${props.basePath}/calls/${call.id}`}>
          <time datetime={call.startedAt}>{call.startedAt}</time>
        </a>
      </td>
      <td>{call.brand}</td>
      <td>{call.kind}</td>
      <td>{call.status}</td>
      <td class="number">{took(call.durationMs)}</td>
      <td>
        {call.error === null ? (
          "—"
        ) : (
          <code>
            {call.error.module}.{call.error.code}
          </code>
        )}
      </td>
    </tr>
  );
}

export function Calls(props: CallsProps) {
  const path = `${props.basePath}/calls`;
  return (
    <Layout title="meco — Calls">
      <h1>Calls</h1>
      <nav>
        <Pages basePath={props.basePath} here="calls" />
        <Filter
          path={path}
          query={props.query}
          fields={CALLS_FIELDS}
          heading="brand"
          field="brand"
          options={props.brands.map((one) => ({
            value: one.id,
            label: one.name,
          }))}
        />
        <Filter
          path={path}
          query={props.query}
          fields={CALLS_FIELDS}
          heading="status"
          field="status"
          options={STATUSES.map((one) => ({ value: one, label: one }))}
        />
      </nav>

      {props.calls.length === 0 ? (
        <p class="empty">Nothing here yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>started</th>
              <th>brand</th>
              <th>kind</th>
              <th>status</th>
              <th class="number">took</th>
              <th>error</th>
            </tr>
          </thead>
          <tbody>
            {props.calls.map((call) => (
              <Row basePath={props.basePath} call={call} />
            ))}
          </tbody>
        </table>
      )}

      <Older
        path={path}
        query={props.query}
        fields={CALLS_FIELDS}
        cursor={props.cursor}
      />
    </Layout>
  );
}
