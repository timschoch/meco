/**
 * The `render` pipeline: one photograph, one Template, one Placement, one
 * Render, in the order `docs/specs/gateway.md` gives under "The pipeline".
 *
 * Everything the gateway is for happens here and nowhere else. It fetches or
 * finds the bytes, answers a Replay off the Request Hash before any module
 * runs, gets the Annotation, asks identify who is in it, asks compose what the
 * Template leaves free, builds the FramingRequest and lets the contract refuse
 * it, asks frame for the window, decodes once, hides the strangers, renders,
 * files the bytes and writes the Call. It owns no arithmetic on a pixel beyond
 * the decode and no rule any module already holds.
 */
import { plan as composePlan, render as composeRender } from "@meco/compose";
import { placement as placementById } from "@meco/compose/placements";
import {
  type Annotation,
  DEFAULT_PIN_TO,
  FramingRequest,
} from "@meco/contracts";
import { type Framing, frameCrop, projectIntoFrame } from "@meco/frame";
import type { FaceVerdict, Identification, Identify } from "@meco/identify";
import { type RedactionRecord, redact } from "@meco/redact";
import type { Caller, Records } from "@meco/records";
import type { Store } from "@meco/store";
import { z } from "zod";
import { type AnnotateDeps, annotationOf } from "./annotate";
import { decodeAt } from "./decode";
import { Brand, FramingOptions } from "./inputs";
import { requestHash } from "./request-hash";
import { SourceReference, resolveSource } from "./source";
import { type Trace, recorded } from "./trace";

/** The `render_image` Operation's input, on both Doors. */
export const RenderInput = z.object({
  brand: Brand,
  template: z.string().min(1),
  placement: z.string().min(1),
  fields: z.record(z.string(), z.unknown()),
  source: SourceReference,
  ...FramingOptions,
});

export type RenderInput = z.output<typeof RenderInput>;

/** Everything the pipeline reaches. An `OperationContext` is one of these. */
export interface RenderDeps extends AnnotateDeps {
  readonly records: Records;
  readonly store: Store;
  readonly identify: Identify;
  readonly fetch: typeof fetch;
  readonly caller: Caller;
  now(): Date;
}

/**
 * What the gateway says about one face Region of one output: identify's
 * verdict, whether redact hid it and whether frame's window kept it. Assembled
 * here because no single module knows all three, and never stored (`CONTEXT.md`,
 * Face Report).
 */
export interface FaceReport {
  readonly regionId: string;
  readonly verdict: FaceVerdict["verdict"];
  readonly personId?: string;
  readonly similarity?: number;
  readonly hidden: boolean;
  readonly inFrame: boolean;
}

/**
 * A type alias and not an interface: an Operation answers a
 * `Record<string, unknown>`, which the MCP Door carries as
 * `structuredContent`, and only an alias gets the implicit index signature
 * that makes it one.
 */
export type RenderAnswer = {
  readonly output: {
    readonly url: string;
    readonly key: string;
    readonly kind: "render";
    readonly placement: string;
    readonly width: number;
    readonly height: number;
    readonly mime: string;
    readonly bytes: number;
  };
  readonly call: { readonly id: string; readonly replayed: boolean };
  readonly framing: Framing;
  readonly faces: readonly FaceReport[];
};

/** What one pass through the modules produced, before the Call row exists. */
interface Rendered {
  readonly storeKey: string;
  readonly mime: string;
  readonly bytes: number;
  readonly requestHash: string;
  readonly framing: Framing;
  readonly faces: readonly FaceReport[];
  /** True when records answered and no module ran. */
  readonly replayed: boolean;
}

export async function renderImage(
  deps: RenderDeps,
  input: RenderInput
): Promise<RenderAnswer> {
  const { brand, placement } = input;

  const { call, result } = await recorded(
    deps,
    deps.caller,
    brand,
    "render",
    (trace) => pipeline(deps, input, trace)
  );

  // Not a Step: the row cannot time its own write, and a Replay files no
  // second Output — one Output, two Calls, which is what happened.
  if (!result.replayed) {
    await deps.records.outputs.record({
      brand,
      storeKey: result.storeKey,
      callId: call.id,
      kind: "render",
      placement,
      requestHash: result.requestHash,
    });
  }

  // The Placement is the canvas compose drew on, so the output's size is a
  // fact of the catalogue and costs no second decode of the bytes just
  // written. Unreachable: compose refuses a Placement it does not hold before
  // anything is rendered, so this is a catalogue that disagrees with itself.
  const size = placementById(placement);
  if (size === undefined) {
    throw new Error(`compose rendered for the unknown Placement ${placement}`);
  }

  return {
    output: {
      url: deps.store.publicUrl(result.storeKey),
      key: result.storeKey,
      kind: "render",
      placement,
      width: size.width,
      height: size.height,
      mime: result.mime,
      bytes: result.bytes,
    },
    call: { id: call.id, replayed: result.replayed },
    framing: result.framing,
    faces: result.faces,
  };
}

async function pipeline(
  deps: RenderDeps,
  input: RenderInput,
  trace: Trace
): Promise<Rendered> {
  const { brand } = input;

  const source = await resolveSource(deps, brand, input.source, trace);
  trace.sourceHash(source.hash);
  const request = { ...input, source: { hash: source.hash } };
  trace.request(request);
  const hash = requestHash(request);

  const replay = await replayOf(deps, brand, source.hash, hash, trace);
  if (replay !== null) return replay;

  const annotation = await annotationOf(deps, brand, source, trace);

  const identification = await trace.step("identify.match", () =>
    deps.identify.match({ annotation, brand })
  );
  trace.matches(identification);

  const plan = await trace.step("compose.plan", () =>
    composePlan({
      template: input.template,
      placement: input.placement,
      brand,
      fields: input.fields,
    })
  );

  // The contract refuses the request, not the gateway: a 17th Occlusion Zone
  // or a ladder naming a rung twice is a `400 invalid_request` from the same
  // schema frame is written against, before frame runs.
  const framingRequest = FramingRequest.parse({
    brand,
    source: { hash: source.hash },
    target: {
      ...plan.imageSlot,
      ...(input.format === undefined ? {} : { format: input.format }),
      ...(input.quality === undefined ? {} : { quality: input.quality }),
    },
    pinTo: input.pinTo ?? DEFAULT_PIN_TO,
    ...(input.persons === undefined ? {} : { persons: input.persons }),
    ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
    ...(plan.subjectArea === undefined
      ? {}
      : { subjectArea: plan.subjectArea }),
    occlusion: [...plan.occlusion],
    // The safe answer is the default one (ADR-0014, Decision 6).
    redaction: {
      blurUnknownFaces: input.redaction?.blurUnknownFaces ?? true,
    },
  });

  const framing = await trace.step("frame.crop", async () =>
    frameCrop({
      annotation,
      matches: [...identification.matches],
      request: framingRequest,
    })
  );
  trace.framing(framing);

  const decoded = await trace.step("source.decode", async () =>
    decodeAt(await source.bytes(), annotation)
  );

  const hidden = await trace.step("redact.blur", () =>
    redact({
      image: decoded,
      regions: annotation.regions,
      matches: identification.matches,
      redaction: framingRequest.redaction,
    })
  );
  trace.redactions(hidden.redactions);

  const rendered = await trace.step("compose.render", () =>
    composeRender({
      template: input.template,
      placement: input.placement,
      brand,
      fields: input.fields,
      source: hidden.image,
      window: framing.windowFraction,
      ...(input.format === undefined ? {} : { format: input.format }),
      ...(input.quality === undefined ? {} : { quality: input.quality }),
    })
  );

  const put = await trace.step("store.put", () =>
    deps.store.put("renders", rendered.bytes, rendered.mime)
  );

  return {
    storeKey: put.key,
    mime: rendered.mime,
    bytes: rendered.bytes.byteLength,
    requestHash: hash,
    framing,
    faces: faceReports(annotation, identification, hidden.redactions, framing),
    replayed: false,
  };
}

/**
 * The Replay: the Output an equal request already produced, with its Framing
 * and its Face Report read back off the Call that made it.
 *
 * One Step, because everything under it is records answering: the lookup, the
 * Call the Output points at, the Annotation the Report is drawn over and the
 * head of the stored bytes. A Replay that cannot assemble all four is a miss
 * and the pipeline renders again — after a Sweep the Annotation may be gone,
 * and a Brand asking twice deserves a picture rather than a 500.
 */
async function replayOf(
  deps: RenderDeps,
  brand: string,
  sourceHash: string,
  hash: string,
  trace: Trace
): Promise<Rendered | null> {
  return trace.step("records.replay", async () => {
    const output = await deps.records.outputs.byRequest(brand, hash);
    if (output === null) return null;

    const [call, annotation, head] = await Promise.all([
      deps.records.calls.get(output.callId),
      deps.records.annotations.get(sourceHash),
      deps.store.head(output.storeKey),
    ]);
    if (call === null || annotation === null || head === null) return null;

    // Written by frame, identify and redact and stored unread, so this is the
    // one place the three shapes are named again.
    const framing = call.framing as Framing;
    const identification = call.matches as Identification | null;
    const redactions = (call.redactions ?? []) as readonly RedactionRecord[];
    if (framing === null || identification === null) return null;

    return {
      storeKey: output.storeKey,
      mime: head.contentType,
      bytes: head.size,
      requestHash: hash,
      framing,
      faces: faceReports(annotation, identification, redactions, framing),
      replayed: true,
    };
  });
}

/** True when any part of the Box lands inside the frame frame cut. */
const intersectsFrame = (box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): boolean =>
  box.x < 1 && box.y < 1 && box.x + box.width > 0 && box.y + box.height > 0;

function faceReports(
  annotation: Annotation,
  identification: Identification,
  redactions: readonly RedactionRecord[],
  framing: Framing
): readonly FaceReport[] {
  const hidden = new Set(redactions.map((one) => one.regionId));
  const boxes = new Map(annotation.regions.map((one) => [one.id, one.box]));

  return identification.faces.map((face) => {
    const box = boxes.get(face.regionId);
    return {
      regionId: face.regionId,
      verdict: face.verdict,
      ...(face.verdict === "match"
        ? { personId: face.personId, similarity: face.similarity }
        : {}),
      hidden: hidden.has(face.regionId),
      // A face the window cut away maps outside the unit box, which is frame's
      // answer to "is it still in the picture" and not a rounding of ours.
      inFrame:
        box !== undefined && intersectsFrame(projectIntoFrame(framing, box)),
    };
  });
}
