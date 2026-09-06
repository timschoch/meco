/**
 * The Call View: what one Call was asked for, what every module answered, how
 * long each Step took, what it cost, what failed, and the Outputs it made.
 *
 * A failed Call renders like any other. That is the whole point of the page:
 * without it a failure is a gap in the Gallery rather than something a person
 * can read.
 */
import type { Call, Output, Step } from "@meco/records";
import type { Store } from "@meco/store";
import { Layout } from "./layout";
import { percent } from "./percent";

export interface CallProps {
  readonly basePath: string;
  readonly call: Call;
  readonly outputs: readonly Output[];
  readonly moreOutputs: boolean;
  readonly store: Pick<Store, "publicUrl">;
}

/** The Gallery's own path, which is the sub-app's root wherever it is mounted. */
const galleryPath = (basePath: string): string =>
  basePath === "" ? "/" : basePath;

function Facts(props: { call: Call }) {
  const { call } = props;
  return (
    <dl class="facts">
      <dt>status</dt>
      <dd>{call.status}</dd>
      <dt>started</dt>
      <dd>
        <time datetime={call.startedAt}>{call.startedAt}</time>
      </dd>
      <dt>took</dt>
      <dd>{call.durationMs === null ? "—" : `${call.durationMs} ms`}</dd>
      <dt>call</dt>
      <dd>
        <code>{call.id}</code>
      </dd>
    </dl>
  );
}

/**
 * The Steps as bars. The longest Step is the full width, so the bars answer
 * "which module took the time" at a glance; the duration is written out beside
 * every bar, including a Step that took no measurable time, because a Step that
 * ran is a Step that happened.
 */
function Steps(props: { steps: readonly Step[] }) {
  if (props.steps.length === 0) {
    return <p class="note">No Step was recorded for this Call.</p>;
  }
  const longest = Math.max(...props.steps.map((step) => step.durMs), 0);
  return (
    <ol class="steps">
      {props.steps.map((step) => (
        <li>
          <span class="step-name">{step.name}</span>
          <span class="bar">
            <span
              class="bar-fill"
              style={`width: ${longest === 0 ? percent(0) : percent(step.durMs / longest)}`}
            />
          </span>
          <span class="step-dur">{step.durMs} ms</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * What the gateway charged. Its shape is the gateway's and webui reads none of
 * it: an object is listed as the key/value pairs it holds, anything else is
 * printed as it stands, and `null` is the Call the gateway did not price.
 */
function Cost(props: { cost: unknown }) {
  const { cost } = props;
  if (cost === null || cost === undefined) {
    return <p class="note">not priced</p>;
  }
  if (typeof cost !== "object" || Array.isArray(cost)) {
    return <pre>{JSON.stringify(cost)}</pre>;
  }
  return (
    <dl class="facts">
      {Object.entries(cost).map(([key, value]) => (
        <>
          <dt>{key}</dt>
          <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
        </>
      ))}
    </dl>
  );
}

/** A shape another module owns, printed as records stored it: unread. */
function Verbatim(props: { value: unknown; absent: string }) {
  if (props.value === null || props.value === undefined) {
    return <p class="note">{props.absent}</p>;
  }
  return <pre>{JSON.stringify(props.value, null, 2)}</pre>;
}

function Outputs(props: {
  basePath: string;
  outputs: readonly Output[];
  more: boolean;
  store: Pick<Store, "publicUrl">;
}) {
  if (props.outputs.length === 0) {
    return <p class="note">This Call made no Output.</p>;
  }
  return (
    <>
      <div class="grid">
        {props.outputs.map((output) => (
          <div class="card">
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
              <dt>key</dt>
              <dd>
                <code>{output.storeKey}</code>
              </dd>
            </dl>
          </div>
        ))}
      </div>
      {props.more ? (
        <p class="note">This Call made more Outputs than this page shows.</p>
      ) : null}
    </>
  );
}

export function CallView(props: CallProps) {
  const { call } = props;
  return (
    <Layout title={`meco — ${call.kind} for ${call.brand}`}>
      <p>
        <a href={galleryPath(props.basePath)}>← Gallery</a>
      </p>
      <h1>
        {call.kind} for {call.brand}
      </h1>
      <Facts call={call} />

      {call.error === null ? null : (
        <div class="error">
          <p>
            <code>
              {call.error.module}: {call.error.code}
            </code>
          </p>
          <p>{call.error.message}</p>
        </div>
      )}

      {call.sourceHash === null ? null : (
        <>
          <h2>Source</h2>
          {/*
            The redirect route and never a Signed URL. The route checks the
            Source Hold and mints a URL that lives a minute, so a saved page
            holds no photograph.
          */}
          <img
            class="source"
            src={`${props.basePath}/calls/${call.id}/source`}
            alt="the Source Image of this Call"
            loading="lazy"
            decoding="async"
          />
        </>
      )}

      <h2>Steps</h2>
      <Steps steps={call.steps} />

      <h2>Cost</h2>
      <Cost cost={call.cost} />

      <h2>Outputs</h2>
      <Outputs
        basePath={props.basePath}
        outputs={props.outputs}
        more={props.moreOutputs}
        store={props.store}
      />

      <h2>Request as sent</h2>
      <Verbatim value={call.request} absent="No request was recorded." />

      <h2>Framing</h2>
      <Verbatim value={call.framing} absent="No window was framed." />

      <h2>Matches</h2>
      <Verbatim value={call.matches} absent="No face was identified." />

      <h2>Redactions</h2>
      <Verbatim value={call.redactions} absent="No face was hidden." />
    </Layout>
  );
}
