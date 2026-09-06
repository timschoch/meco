/**
 * The People handlers: create, enrol, list, erase.
 *
 * Two of the four are Calls. `add_reference_photo` runs a model and writes a
 * biometric template, `erase_person` deletes one, and both are things the owner
 * has to be able to read back off a row rather than guess at from a log
 * (`docs/specs/gateway.md`, the Operation table). `add_person` and `list_people`
 * write no Face Print and run no model, so they are rows in `people` and
 * nothing else.
 *
 * Nothing here reaches a Face Print. A Person and an Erasure are records' own
 * public shapes and travel whole; a Reference Photo does not. {@link onTheWire}
 * names the fields of one that may leave, because a spread would put every
 * column records later adds on the wire by default, and the column this module
 * must never leak is exactly the one that would arrive that way (user story
 * 16). `list_people` and the Enrolment both answer through it.
 */
import { type Annotator, identify } from "@meco/identify";
import { NumbersTaken, type ReferencePhoto } from "@meco/records";
import { modelsUnbound } from "./catalogue";
import { GatewayError } from "./errors";
import type { OperationContext } from "./operations";
import { type SourceReference, resolveSource } from "./source";
import { type Trace, recorded } from "./trace";

/** People with their Reference Photos as the wire may carry them: no print, no Store Key. */
export const listPeople = async (ctx: OperationContext) => {
  const perBrand = await Promise.all(
    ctx.brands.map((brand) => ctx.records.people.list(brand))
  );
  const items = perBrand.flat().map((person) => ({
    id: person.id,
    brand: person.brand,
    name: person.name,
    numbers: person.numbers,
    createdAt: person.createdAt,
    photos: person.photos.map(onTheWire),
  }));
  return { items };
};

/**
 * One Reference Photo as a caller may see it. The Face Print is a biometric
 * template and never leaves the deployment; the Store Key is the private
 * object's address and is the webui's business, not an API caller's.
 */
const onTheWire = (photo: ReferencePhoto) => ({
  id: photo.id,
  personId: photo.personId,
  hash: photo.hash,
  regionId: photo.regionId,
  consentAt: photo.consentAt,
  createdAt: photo.createdAt,
});

/**
 * A Person travels whole: `id`, `brand`, `name`, `createdAt`, and records has
 * no fifth column here to keep back. Copied into a fresh object because an
 * Operation answers `Record<string, unknown>` — the MCP Door carries it as
 * `structuredContent` — and an interface has no index signature to satisfy it.
 */
export const addPerson = async (
  ctx: OperationContext,
  input: {
    readonly brand: string;
    readonly name: string;
    readonly numbers?: readonly string[];
  }
) => ({ ...(await conflictAware(() => ctx.records.people.create(input))) });

/**
 * Replaces a Person's race numbers. `404` for a Person of another Brand or
 * none at all, which is the same answer and the same words `erase_person`
 * gives: an id is not a capability.
 *
 * A whole-list replace, because records' seam is one. A Brand knows what its
 * driver carries this season, and an add-and-remove pair would leave a moment
 * where the Person holds a number nobody gave them.
 */
export const setPersonNumbers = async (
  ctx: OperationContext,
  {
    brand,
    id,
    numbers,
  }: {
    readonly brand: string;
    readonly id: string;
    readonly numbers: readonly string[];
  }
) => {
  const person = await conflictAware(() =>
    ctx.records.people.setNumbers(brand, id, numbers)
  );
  if (person === null) {
    throw new GatewayError("not_found", `No Person ${id} in brand ${brand}.`);
  }
  return { ...person };
};

/**
 * A race number another Person of this Brand already carries, as the wire's
 * `409 conflict` rather than a `500`.
 *
 * The refusal is records' constraint and the message names the number and its
 * holder, because the caller's next move is to pick another number or to look
 * at the Person who has it. Every other failure travels on untouched.
 */
const conflictAware = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof NumbersTaken)) throw error;
    throw new GatewayError(
      "conflict",
      error.taken
        .map(
          (one) =>
            `race number ${one.number} already belongs to person ${one.personId}`
        )
        .join("; ")
    );
  }
};

/**
 * Erasure, answered as records reports it — including `remaining`, its own
 * listing of `people/<brand>/<personId>` after the deletes. That listing is the
 * proof and not a claim about one: a store that refused a delete shows up in it
 * rather than behind a `true`.
 *
 * A Person of another Brand is `404 not_found`, the same answer and the same
 * words as an id nobody has. records already refuses to read another Brand's
 * row, so the two cases arrive here as the same `erased: false`.
 */
export const erasePerson = async (
  ctx: OperationContext,
  { brand, id }: { readonly brand: string; readonly id: string }
) => {
  const { result } = await recorded(
    ctx,
    ctx.caller,
    brand,
    "erase",
    async (trace) => {
      trace.request({ brand, id });
      const erasure = await trace.step("records.people.erase", () =>
        ctx.records.people.erase(brand, id)
      );
      if (!erasure.erased) {
        throw new GatewayError(
          "not_found",
          `No Person ${id} in brand ${brand}.`
        );
      }
      // Copied for the same reason a Person is, and with nothing left out: the
      // Erasure is records' own report and every field of it is the proof.
      return { ...erasure };
    }
  );
  return result;
};

/**
 * Enrolment. The door resolves the Source Reference to bytes and hands them to
 * identify, which does everything else: the Annotation, the choice of face, the
 * four refusals, and the writes — refused whole or done whole (ADR-0012,
 * Decision 4). The gateway adds no rule of its own here, and takes none away.
 *
 * A photograph with several faces is answered `200 { status: "choose", faces }`
 * and not an error, because it is a normal photograph and the caller's next
 * move is the same request with a `regionId` (decision on #87, Q11).
 *
 * The Source Reference is resolved to bytes and no further: the
 * `store.put("sources")`, `files.ensure` and `sources.hold` that `annotate`
 * does are not run here. identify files these bytes itself, under
 * `people/<brand>/<personId>` and with the Annotation's own width and height,
 * which nothing has before models has answered; and a Source Hold is half a
 * Reference Count, so holding would leave `people.erase` unable to take the
 * File with the Person (`docs/specs/gateway.md`, "Inputs").
 */
export const addReferencePhoto = async (
  ctx: OperationContext,
  input: {
    readonly brand: string;
    readonly id: string;
    readonly source: SourceReference;
    readonly consentAt?: string;
    readonly regionId?: string;
  }
) => {
  const { brand, id, source, consentAt, regionId } = input;

  const { result } = await recorded(
    ctx,
    ctx.caller,
    brand,
    "enrol",
    async (trace) => {
      const resolved = await resolveSource(ctx, brand, source, trace);
      trace.sourceHash(resolved.hash);
      // The Source Reference as records keeps it: whichever form the caller
      // used, the row names the bytes by their hash.
      trace.request({
        brand,
        id,
        source: { hash: resolved.hash },
        consentAt,
        regionId,
      });

      const enrolment = await trace.step("identify.enrol", async () =>
        identify({
          records: ctx.records,
          store: ctx.store,
          annotate: annotatorOf(ctx, trace),
        }).enrol({
          brand,
          personId: id,
          bytes: await resolved.bytes(),
          contentType: await resolved.contentType(),
          // An absent date becomes an Invalid Date, which is what identify
          // refuses as `consent_required`. Absent, null and unparseable are one
          // case and get one answer: no Face Print of a person who has not
          // agreed.
          consentAt: new Date(consentAt ?? ""),
          ...(regionId === undefined ? {} : { regionId }),
        })
      );

      if (enrolment.status === "choose") {
        return { status: "choose", faces: enrolment.faces } as const;
      }
      // The Annotation identify also answers is not on the wire: it carries a
      // Face Print per face, and the Operation that hands an Annotation back
      // with the prints stripped is `find_subjects`.
      return { status: "enrolled", photo: onTheWire(enrolment.photo) } as const;
    }
  );
  return result;
};

/**
 * identify's Annotator, over the same models client every other stage uses, so
 * models' own clock lands as `models.<stage>` Steps on this Call too. An
 * enrolment never reads the Annotation cache: identify hashes the bytes it was
 * given and asks for an Annotation of exactly those, and it writes the answer
 * back itself.
 */
const annotatorOf =
  (ctx: OperationContext, trace: Trace): Annotator =>
  async (source, options) => {
    const models = ctx.models;
    if (models === null) throw modelsUnbound();
    const { annotation, serverTiming } = await models.annotateTimed(
      source,
      options
    );
    for (const { name, durMs } of serverTiming) {
      trace.add({ name: `models.${name}`, durMs });
    }
    return annotation;
  };
