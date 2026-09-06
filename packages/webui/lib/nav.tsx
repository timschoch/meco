/**
 * The links both lists share: which page you are on, what the page is narrowed
 * to, and how to reach the one behind it.
 *
 * Every one of them is an `<a>`. There is no form and no script, so a link is
 * the whole of the interaction and the query string is the whole of the state.
 */
import { type Links, linkTo } from "./query";

/** The two lists, and which of them is being read. */
export function Pages(props: { basePath: string; here: "gallery" | "calls" }) {
  const at = props.basePath === "" ? "/" : props.basePath;
  return (
    <section>
      <h2>page</h2>
      <a href={at} aria-current={props.here === "gallery" ? "true" : "false"}>
        gallery
      </a>
      <a
        href={`${props.basePath}/calls`}
        aria-current={props.here === "calls" ? "true" : "false"}
      >
        calls
      </a>
    </section>
  );
}

/** One field of the query, as "all" and one link per value it may take. */
export function Filter<Field extends string>(props: {
  links: Links<Field>;
  heading: string;
  field: Field;
  options: readonly { value: string; label: string }[];
}) {
  const selected = props.links.query[props.field];
  return (
    <section>
      <h2>{props.heading}</h2>
      <a
        href={linkTo(props.links, { field: props.field })}
        aria-current={selected === undefined ? "true" : "false"}
      >
        all
      </a>
      {props.options.map((option) => (
        <a
          href={linkTo(props.links, {
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

/** The one page behind this one, or nothing when this is the last. */
export function Older<Field extends string>(props: {
  links: Links<Field>;
  cursor: string | null;
}) {
  if (props.cursor === null) return null;
  return (
    <a class="older" href={linkTo(props.links, { cursor: props.cursor })}>
      older →
    </a>
  );
}
