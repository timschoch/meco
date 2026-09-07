/**
 * The Call View: what one Call was asked for, what every module answered, how
 * long each Step took, what it cost, what failed, and the Outputs it made.
 *
 * A failed Call renders like any other. That is the whole point of the page:
 * without it a failure is a gap in the Gallery rather than something a person
 * can read.
 */
import type { Output, Step } from "@meco/records";
import type { Store } from "@meco/store";
import type {
  CallView as CallViewData,
  FaceVerdictRow,
  MatchRow,
  RedactionRow,
} from "./call-page";
import { Layout } from "./layout";
import { Overlay } from "./overlay";
import { percent } from "./percent";

export interface CallProps {
  readonly basePath: string;
  readonly view: CallViewData;
  readonly store: Pick<Store, "publicUrl">;
}

type Call = CallViewData["call"];

/** The Gallery's own path, which is the sub-app's root wherever it is mounted. */
const galleryPath = (basePath: string): string =>
  basePath === "" ? "/" : basePath;

/** The redirect route the Source Thumbnail is fetched through. */
const sourcePath = (basePath: string, id: string): string =>
  `${basePath}/calls/${id}/source`;

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

/**
 * Whom this Call named, and by which rule. One line per Match.
 *
 * Above the Face Verdicts because a number Match has none: it names a
 * `vehicle` Region, and a page that only listed faces would show nothing at
 * all for the Call that framed a driver in a helmet.
 */
function Named(props: {
  matches: readonly MatchRow[];
  names: ReadonlyMap<string, string>;
}) {
  if (props.matches.length === 0) return null;
  return (
    <dl class="facts">
      {props.matches.map((one) => (
        <>
          <dt>{one.regionId}</dt>
          <dd>
            {props.names.get(one.personId) ?? one.personId}
            {one.by === "number"
              ? ` — by race number, read on ${one.numberRegionId ?? "a number Region"}`
              : ` — by face${one.similarity === undefined ? "" : ` (${one.similarity})`}`}
          </dd>
        </>
      ))}
    </dl>
  );
}

/** identify's verdict for every face, with the Person named where there is one. */
function Faces(props: {
  faces: readonly FaceVerdictRow[] | null;
  names: ReadonlyMap<string, string>;
  raw: unknown;
}) {
  if (props.faces === null) {
    return <Verbatim value={props.raw} absent="No face was identified." />;
  }
  if (props.faces.length === 0) {
    return <p class="note">No face was identified.</p>;
  }
  return (
    <dl class="facts">
      {props.faces.map((one) => (
        <>
          <dt>{one.regionId}</dt>
          <dd>
            {one.verdict}
            {one.personId === undefined
              ? ""
              : ` — ${props.names.get(one.personId) ?? one.personId}`}
            {one.similarity === undefined ? "" : ` (${one.similarity})`}
          </dd>
        </>
      ))}
    </dl>
  );
}

/** What redact hid, one line per face. */
function Redactions(props: {
  redactions: readonly RedactionRow[] | null;
  raw: unknown;
}) {
  if (props.redactions === null) {
    return <Verbatim value={props.raw} absent="No face was hidden." />;
  }
  if (props.redactions.length === 0) {
    return <p class="note">No face was hidden.</p>;
  }
  return (
    <dl class="facts">
      {props.redactions.map((one) => (
        <>
          <dt>{one.regionId}</dt>
          <dd>hidden — {one.reason}</dd>
        </>
      ))}
    </dl>
  );
}

/**
 * A Replay made no Output of its own: the row stays on the Call that first made
 * it, which is what "one Output and two Calls" means. So the page points at
 * that Call rather than pretending this one produced something.
 *
 * A link and not the picture. The Call it links loads that Render at full size
 * already, and a Render measures 0.7 to 2.5 MB PNG (compose goldens,
 * `packages/compose/tests/goldens`, seven files, 6 Sep 2026).
 */
function Replayed(props: { basePath: string; output: Output }) {
  return (
    <p class="note">
      This Call replayed an earlier Output, so no module ran.{" "}
      <a href={`${props.basePath}/calls/${props.output.callId}`}>
        The Call that made it
      </a>{" "}
      holds <code>{props.output.storeKey}</code>.
    </p>
  );
}

export function CallView(props: CallProps) {
  const { call, overlay } = props.view;
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
          {overlay === null ? (
            <img
              class="source"
              src={sourcePath(props.basePath, call.id)}
              alt="the Source Image of this Call"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <Overlay
              src={sourcePath(props.basePath, call.id)}
              overlay={overlay}
            />
          )}
        </>
      )}

      <h2>Steps</h2>
      <Steps steps={call.steps} />
      {props.view.replayed === null ? null : (
        <Replayed basePath={props.basePath} output={props.view.replayed} />
      )}

      <h2>Cost</h2>
      <Cost cost={call.cost} />

      <h2>Outputs</h2>
      <Outputs
        outputs={props.view.outputs}
        more={props.view.moreOutputs}
        store={props.store}
      />

      <h2>Request as sent</h2>
      <Verbatim value={call.request} absent="No request was recorded." />

      <h2>Framing</h2>
      {/*
        The two fields of the Framing read out on their own. Which layout of
        the Template the picture got is the first thing a reader asks of a
        Render whose caption is not where the design puts it; the Redaction
        Policy is the first thing they ask of one where a stranger's face is
        showing, and the level that decided it is where they go to change it.
      */}
      {props.view.variant === null && props.view.redaction === null ? null : (
        <dl class="facts">
          {props.view.variant === null ? null : (
            <>
              <dt>variant</dt>
              <dd>
                <code>{props.view.variant}</code>
              </dd>
            </>
          )}
          {props.view.redaction === null ? null : (
            <>
              <dt>redaction</dt>
              <dd>
                <code>
                  blurUnknownFaces={String(
                    props.view.redaction.blurUnknownFaces
                  )}
                </code>{" "}
                from the <code>{props.view.redaction.from}</code>
              </dd>
            </>
          )}
        </dl>
      )}
      <Verbatim value={call.framing} absent="No window was framed." />

      <h2>Matches</h2>
      <Named matches={props.view.matches} names={props.view.names} />
      <Faces
        faces={props.view.faces}
        names={props.view.names}
        raw={call.matches}
      />

      <h2>Redactions</h2>
      <Redactions redactions={props.view.redactions} raw={call.redactions} />
    </Layout>
  );
}
