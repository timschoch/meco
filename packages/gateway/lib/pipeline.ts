/**
 * The pipeline `docs/specs/gateway.md` gives under "The pipeline", once, for
 * every Call kind that turns one photograph into one Output.
 *
 * It fetches or finds the bytes, answers a Replay off the Request Hash before
 * any module runs, gets the Annotation, asks identify who is in it, builds the
 * FramingRequest and lets the contract refuse it, asks frame for the window,
 * decodes once, hides the strangers, paints, files the bytes and hands back
 * what the Call row and the answer are assembled from. It owns no arithmetic
 * on a pixel beyond the decode and no rule any module already holds.
 *
 * Two of the spec's stages differ per kind, so they are the interface: the
 * {@link Stages} a caller fills in. `render` plans a Template and draws it;
 * `crop` takes its target from the request and draws nothing. Everything
 * between and around them is the same work in the same order, and the spec's
 * table says so — a second copy of it would be a second place for the order to
 * be wrong in.
 */
import type { RenderResult } from "@meco/compose";
import {
  type Annotation,
  type Box,
  type CropAnchor,
  DEFAULT_PIN_TO,
  type DecodedImage,
  FramingRequest,
  type PinTo,
  type Size,
} from "@meco/contracts";
import { type Framing, frameCrop, projectIntoFrame } from "@meco/frame";
import type { FaceVerdict, Identification, Identify } from "@meco/identify";
import { type RedactionRecord, redact } from "@meco/redact";
import type { Caller, Records } from "@meco/records";
import type { Namespace, Store } from "@meco/store";
import { type AnnotateDeps, annotationOf } from "./annotate";
import { decodeAt } from "./decode";
import { requestHash } from "./request-hash";
import { type SourceReference, resolveSource } from "./source";
import type { Trace } from "./trace";

/** Everything the pipeline reaches. An `OperationContext` is one of these. */
export interface PipelineDeps extends AnnotateDeps {
  readonly records: Records;
  readonly store: Store;
  readonly identify: Identify;
  readonly fetch: typeof fetch;
  readonly caller: Caller;
  now(): Date;
}

/**
 * What every Operation that produces an Output takes at the door: the Brand,
 * the bytes and the Framing options `lib/inputs.ts` declares. A kind's own
 * fields — a Template, a size — are its own type's business.
 */
export interface FramingInput {
  readonly brand: string;
  readonly source: SourceReference;
  readonly pinTo?: readonly PinTo[];
  readonly persons?: readonly string[];
  readonly anchor?: CropAnchor;
  readonly redaction?: { readonly blurUnknownFaces?: boolean };
  readonly format?: "png" | "jpeg" | "webp";
  readonly quality?: number;
}

/**
 * What the output must fill and what will be drawn over it: compose's Plan for
 * a Render, the request's own size for a Crop. Read by the FramingRequest and
 * by nothing else.
 */
export interface Layout {
  /** The Image Slot, in whole pixels. */
  readonly target: Size;
  /** What the Template will cover, in Image Slot fractions. Empty for a Crop. */
  readonly occlusion: readonly Box[];
  /** Where the Subject must land, in Image Slot fractions. */
  readonly subjectArea?: Box;
}

/** The two stages of the pipeline one Call kind fills in. */
export interface Stages<I extends FramingInput> {
  /** The Call kind, the Output kind and the `store.put` Namespace in one. */
  readonly kind: "render" | "crop";
  readonly namespace: Namespace;
  /**
   * Before frame: what is being filled. A Step of its own where a module
   * answers it (`compose.plan`), and none where the request already said.
   */
  layout(input: I, trace: Trace): Promise<Layout>;
  /**
   * After redact: the pixels. Records its own Step, because `compose.render`
   * and `compose.cut` are two names for two different amounts of work.
   */
  paint(
    input: I,
    layout: Layout,
    image: DecodedImage,
    window: Box,
    trace: Trace
  ): Promise<RenderResult>;
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

/** What one pass produced, before the Call row exists. */
interface Produced {
  readonly storeKey: string;
  readonly mime: string;
  readonly bytes: number;
  readonly framing: Framing;
  readonly faces: readonly FaceReport[];
}

/**
 * The two ways a Call ends, as one discriminated union rather than a flag: the
 * Request Hash is a fact of an output that was made and of nothing else, and a
 * Replay must not be able to carry one to `outputs.record`.
 */
export type Made =
  | (Produced & { readonly replayed: false; readonly requestHash: string })
  | (Produced & { readonly replayed: true });

export async function pipeline<I extends FramingInput>(
  deps: PipelineDeps,
  input: I,
  stages: Stages<I>,
  trace: Trace
): Promise<Made> {
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

  const layout = await stages.layout(input, trace);

  // The contract refuses the request, not the gateway: a 17th Occlusion Zone
  // or a ladder naming a rung twice is a `400 invalid_request` from the same
  // schema frame is written against, before frame runs.
  const framingRequest = FramingRequest.parse({
    brand,
    source: { hash: source.hash },
    target: {
      ...layout.target,
      ...(input.format === undefined ? {} : { format: input.format }),
      ...(input.quality === undefined ? {} : { quality: input.quality }),
    },
    pinTo: input.pinTo ?? DEFAULT_PIN_TO,
    ...(input.persons === undefined ? {} : { persons: input.persons }),
    ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
    ...(layout.subjectArea === undefined
      ? {}
      : { subjectArea: layout.subjectArea }),
    occlusion: [...layout.occlusion],
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

  const painted = await stages.paint(
    input,
    layout,
    hidden.image,
    framing.windowFraction,
    trace
  );

  const put = await trace.step("store.put", () =>
    deps.store.put(stages.namespace, painted.bytes, painted.mime)
  );

  return {
    storeKey: put.key,
    mime: painted.mime,
    bytes: painted.bytes.byteLength,
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
 * and the pipeline runs again — after a Sweep the Annotation may be gone, and
 * a Brand asking twice deserves a picture rather than a 500.
 */
async function replayOf(
  deps: PipelineDeps,
  brand: string,
  sourceHash: string,
  hash: string,
  trace: Trace
): Promise<Made | null> {
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
    // one place the three shapes are named again — and the one place a row an
    // older shape wrote has to be survived rather than trusted. Anything that
    // is not the shape this reads is a miss, and the pipeline runs again.
    const framing = call.framing as Framing | null;
    const identification = call.matches as Identification | null;
    const redactions = (call.redactions ?? []) as readonly RedactionRecord[];
    if (framing?.windowFraction === undefined) return null;
    if (!Array.isArray(identification?.faces)) return null;
    if (!Array.isArray(redactions)) return null;

    return {
      storeKey: output.storeKey,
      mime: head.contentType,
      bytes: head.size,
      framing,
      faces: faceReports(annotation, identification, redactions, framing),
      replayed: true,
    };
  });
}

/** True when any part of the Box lands inside the frame frame cut out. */
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
