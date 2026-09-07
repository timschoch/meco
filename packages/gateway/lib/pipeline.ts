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
  DEFAULT_PIN_TO,
  type DecodedImage,
  FramingRequest,
  type RedactionDefault,
  type Size,
} from "@meco/contracts";
import {
  type Framing,
  frameVariants,
  projectIntoFrame,
  type VariantRequest,
} from "@meco/frame";
import type { FaceVerdict, Identification, Identify } from "@meco/identify";
import { type RedactionRecord, redact } from "@meco/redact";
import type { Caller, Records } from "@meco/records";
import type { Template } from "@meco/compose/template";
import type { Namespace, Store } from "@meco/store";
import type { z } from "zod";
import { type AnnotateDeps, annotationOf } from "./annotate";
import { decodeAt } from "./decode";
import type { FramingOptions } from "./inputs";
import { type ResolvedRedaction, resolveRedaction } from "./redaction";
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
  /**
   * The Templates to plan, draw and read defaults from. Absent means compose's
   * own, which is what the deployment runs on; a caller that registered its
   * own Templates hands them here, and every compose call takes the same one
   * so the catalogue, the Plan and the paint cannot be three different sets.
   */
  readonly templates?: ReadonlyMap<string, Template>;
  now(): Date;
}

/**
 * What every Operation that produces an Output takes at the door: the Brand,
 * the bytes and the Framing options. A kind's own fields — a Template, a
 * size — are its own type's business.
 *
 * The options are read off `FramingOptions` rather than restated, so an option
 * added there reaches this without a second edit that nothing would fail for.
 */
export type FramingInput = {
  readonly brand: string;
  readonly source: SourceReference;
} & z.output<z.ZodObject<typeof FramingOptions>>;

/**
 * The Fill: what the output must fill and what will be drawn over it. compose's
 * Plan answers it for a Render; the request itself answers it for a Crop. Read
 * by the FramingRequest and by nothing else.
 */
export interface Fill {
  /** The Image Slot, in whole pixels. */
  readonly target: Size;
  /** What the Template will cover, in Image Slot fractions. Empty for a Crop. */
  readonly occlusion: readonly Box[];
  /** Where the Subject must land, in Image Slot fractions. */
  readonly subjectArea?: Box;
  /**
   * The Template Variant this Fill belongs to, when the Template offers any.
   * What frame's choice comes back naming, and what the paint then draws.
   */
  readonly variant?: string;
}

/** The two stages of the pipeline one Call kind fills in. */
export interface Stages<I extends FramingInput> {
  /** Where the bytes are filed. `renders` for a Render, `crops` for a Crop. */
  readonly namespace: Namespace;
  /**
   * Before frame: the Fills, one per way the output could lay out, most
   * preferred first and never empty. One Plan per Template Variant for a
   * Render, in a Step of its own (`compose.plan`); the request itself, once,
   * for a Crop. frame is handed every one and names the Variant it chose.
   */
  fill(deps: PipelineDeps, input: I, trace: Trace): Promise<readonly Fill[]>;
  /**
   * After redact: the pixels, for the Fill frame chose. Records its own Step,
   * because `compose.render` and `compose.cut` are two names for two different
   * amounts of work.
   */
  paint(
    deps: PipelineDeps,
    input: I,
    fill: Fill,
    image: DecodedImage,
    window: Box,
    trace: Trace
  ): Promise<RenderResult>;
  /**
   * This kind's Template rung of the Redaction Policy, when it has a Template
   * at all. A Render reads the one its Template declares; a Crop leaves this
   * out, which is what makes it walk request → brand → default (#249).
   */
  templateRedaction?(deps: PipelineDeps, input: I): RedactionDefault | undefined;
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
 * What the gateway says about one race number in one output: what was read,
 * whose it is if anybody's, and whether frame's window kept it.
 *
 * The Number Report beside the Face Report, and not folded into it. A face and
 * a number are different Region Kinds carrying different evidence, and a
 * caller reading `faces[]` today must not start finding karts in it.
 *
 * No `hidden`: redact blurs faces, and a race number is a number painted on a
 * kart in a public place. Nothing hides one, so a field saying so on every row
 * would be a promise redact never makes.
 *
 * `personId` is absent for a number nobody enrolled, which is most of them —
 * the picture is full of other people's karts.
 */
export interface NumberReport {
  readonly regionId: string;
  /** The digits, as `ppocr` read them. */
  readonly label: string;
  readonly personId?: string;
  /**
   * Whether the digits landed in the finished frame. Absent where no window
   * was cut: `find_subjects` frames nothing, and a `true` there would be a
   * claim about a picture that does not exist.
   */
  readonly inFrame?: boolean;
}

/**
 * The Framing as the gateway answers and stores it: frame's own, plus the
 * Redaction Policy this output was made under and the level that decided it.
 *
 * frame's shape is left alone. frame is handed the policy on the FramingRequest
 * and has no opinion about where it came from, so `redaction` is the gateway's
 * own line on the Framing rather than a field frame would have to carry.
 *
 * Optional, and only on the way out: every Call this code makes writes it, and
 * a Replay of a Call recorded before #249 has none. Stored shapes are survived,
 * not rewritten — the same rule `scale` and `lowResolution` landed under.
 */
export type CallFraming = Framing & {
  readonly redaction?: ResolvedRedaction;
};

/** What one pass produced, before the Call row exists. */
interface Produced {
  readonly storeKey: string;
  readonly mime: string;
  readonly bytes: number;
  readonly framing: CallFraming;
  readonly faces: readonly FaceReport[];
  readonly numbers: readonly NumberReport[];
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

  // The Redaction Policy, resolved once and handed to every candidate, to
  // redact and to the Framing, so the policy is one fact (#249). Before the
  // Fills, because it is a fact of the request and not of a layout, and the
  // Step order in `docs/specs/gateway.md` says so. The Brand row is read here
  // and not by `resolveRedaction`, which stays pure: the levels are its
  // argument, not its errand.
  const brandRow = await trace.step("records.brand", () =>
    deps.records.brands.get(brand)
  );
  const declared = stages.templateRedaction?.(deps, input);
  const resolved = resolveRedaction({
    ...(input.redaction === undefined ? {} : { request: input.redaction }),
    ...(declared === undefined ? {} : { template: declared }),
    brand: brandRow?.redaction,
  });

  const fills = await stages.fill(deps, input, trace);

  // frame and redact are asked the policy, never where it came from: `from` is
  // the gateway's account of the decision and rides on the Framing, so it can
  // never reach the FramingRequest and therefore never the Request Hash.
  const { from: _from, ...redaction } = resolved;

  // The contract refuses the request, not the gateway: a 17th Occlusion Zone
  // or a ladder naming a rung twice is a `400 invalid_request` from the same
  // schema frame is written against, before frame runs. One request per Fill,
  // because each Variant covers the picture differently and frame is owed
  // every one to choose from.
  const candidates: readonly VariantRequest[] = fills.map((fill) => ({
    ...(fill.variant === undefined ? {} : { variant: fill.variant }),
    request: FramingRequest.parse({
      brand,
      source: { hash: source.hash },
      target: {
        ...fill.target,
        ...(input.format === undefined ? {} : { format: input.format }),
        ...(input.quality === undefined ? {} : { quality: input.quality }),
      },
      pinTo: input.pinTo ?? DEFAULT_PIN_TO,
      ...(input.persons === undefined ? {} : { persons: input.persons }),
      ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
      ...(fill.subjectArea === undefined
        ? {}
        : { subjectArea: fill.subjectArea }),
      occlusion: [...fill.occlusion],
      redaction,
    }),
  }));

  // One Step whatever the count: what a caller reads off the Call is how long
  // framing took, and a Variant is frame's business, not a stage of its own.
  const framing = await trace.step("frame.crop", async () =>
    frameVariants({
      annotation,
      matches: [...identification.matches],
      variants: candidates,
    })
  );
  // The Framing as both the Call row and the answer carry it: frame's own,
  // plus the policy this output was made under and the level that decided it.
  // Built once, so the row and the wire cannot disagree — and so a Replay
  // reads the policy back off the Call rather than resolving it again against
  // a Brand default that may have changed since.
  const callFraming: CallFraming = { ...framing, redaction: resolved };
  trace.framing(callFraming);

  // The Fill frame framed for, found by the name it answered with. Unreachable
  // when missing: frame names one of the Variants it was handed, so this is
  // frame and compose disagreeing about a name.
  const fill = fills.find((one) => one.variant === framing.variant);
  if (fill === undefined) {
    throw new Error(
      `frame chose the Variant ${String(framing.variant)}, which no Fill offered`
    );
  }

  const decoded = await trace.step("source.decode", async () =>
    decodeAt(await source.bytes(), annotation)
  );

  // A Not-a-Face is the helmet itself, not a face resembling one (identify,
  // `NOT_A_FACE_CERTAIN`): nothing to name and nothing to hide. redact holds
  // no threshold and reads no verdict, so the Region is not handed to it at
  // all, and the Face Report says `hidden: false` beside the verdict (#248).
  const notAFace = new Set(
    identification.faces
      .filter((face) => face.verdict === "not-a-face")
      .map((face) => face.regionId)
  );

  const hidden = await trace.step("redact.blur", () =>
    redact({
      image: decoded,
      regions: annotation.regions.filter((region) => !notAFace.has(region.id)),
      matches: identification.matches,
      redaction,
    })
  );
  trace.redactions(hidden.redactions);

  const painted = await stages.paint(
    deps,
    input,
    fill,
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
    framing: callFraming,
    faces: faceReports(annotation, identification, hidden.redactions, framing),
    numbers: numberReports(annotation, identification, framing),
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
    const framing = call.framing as CallFraming | null;
    const identification = call.matches as Identification | null;
    const redactions = (call.redactions ?? []) as readonly RedactionRecord[];
    if (framing?.windowFraction === undefined) return null;
    if (!Array.isArray(identification?.faces)) return null;
    if (!Array.isArray(identification?.matches)) return null;
    if (!Array.isArray(redactions)) return null;

    return {
      storeKey: output.storeKey,
      mime: head.contentType,
      bytes: head.size,
      framing,
      faces: faceReports(annotation, identification, redactions, framing),
      numbers: numberReports(annotation, identification, framing),
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

/**
 * The Number Report: every `number` Region of the Annotation, with the Person
 * whose number it is when identify named one.
 *
 * Read off the Annotation and not off the Matches, so a number nobody enrolled
 * is still reported. That is what makes the report useful for adding a Person:
 * a Brand can see meco read `24` on this kart before it has told meco whose
 * `24` it is.
 *
 * The `personId` comes from the number Match, which names the `vehicle` and
 * carries the `number` Region beside it. Keyed on `numberRegionId` here,
 * because the report is per number and one kart can carry only one of them.
 *
 * `framing` is optional: `find_subjects` cuts no window, and an `inFrame` there
 * would be a claim about a picture that was never made.
 */
export function numberReports(
  annotation: Annotation,
  identification: Identification,
  framing?: Framing
): readonly NumberReport[] {
  const owner = new Map(
    identification.matches.flatMap((match) =>
      match.by === "number"
        ? [[match.numberRegionId, match.personId] as const]
        : []
    )
  );

  return annotation.regions
    .filter((region) => region.kind === "number")
    .map((region) => {
      const personId = owner.get(region.id);
      return {
        regionId: region.id,
        label: region.label,
        ...(personId === undefined ? {} : { personId }),
        ...(framing === undefined
          ? {}
          : {
              inFrame: intersectsFrame(projectIntoFrame(framing, region.box)),
            }),
      };
    });
}
