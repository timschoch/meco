# ADR-0016 — the Redaction Policy resolves through four levels, and an absent level falls to the next one

Status: **accepted, 7 Sep 2026**. Parent: [gateway: the Redaction Policy resolves request → template → brand → default (#249)](https://github.com/timschoch/meco/issues/249). Specs: [`../specs/gateway.md`](../specs/gateway.md) ("The Redaction Policy"), [`../specs/records.md`](../specs/records.md), [`../specs/compose.md`](../specs/compose.md), [`../specs/contracts.md`](../specs/contracts.md). Vocabulary: [`CONTEXT.md`](../../CONTEXT.md), Redaction Policy. **Reverses** one rejected item in [ADR-0008](0008-redact-blurs-the-source-before-the-cut.md) and one in [ADR-0014](0014-gateway-one-operation-table-two-doors.md).

## Context

`blurUnknownFaces` was a per-request flag with one default, `true`. That is the right default and the wrong granularity. A Brand whose photographs are all of its own drivers turns the flag off on every single call, and forgetting it once publishes a stranger's face; a Brand that never wants it off has no way to say so. Neither can express the thing they actually hold an opinion about, which is not this output but their whole account.

[#67](https://github.com/timschoch/meco/issues/67) rejected a Brand default on the ground that it "makes redaction a fact about the Brand rather than about this output". That argument is about where the value is **stored**, and it does not survive the distinction this ADR draws: the resolved policy is still a fact of one output and still lives only on that output's FramingRequest. What a Brand stores is a *default* — an answer for the calls that ask nothing — and a default is a fact about the Brand.

## Decision 1 — four levels, first set wins, and an absent level falls to the next one

The owner's decision, verbatim on #249:

> for B, priority is: 1. request 2. template 3. brand 4. default: on
> omitting it in one level falls to the next level, not to the default value.

| level | where it lives                                | who sets it                    |
| ----- | --------------------------------------------- | ------------------------------ |
| 1     | the request: `redaction.blurUnknownFaces`      | the caller, per call           |
| 2     | the Template: `redaction` in its definition    | the Template's author, in code |
| 3     | the Brand: the `redaction` column on `brands`  | `set_brand_redaction`          |
| 4     | the default: `true`                            | meco                           |

The second sentence is the whole rule. A level that says nothing must be transparent, not opaque: if silence at the Template collapsed to `true`, a Brand could never set a default that any Template failed to restate, and the levels below it would be unreachable. So silence and a decision have to stay tellable apart at every level — which is why the Brand's column is nullable rather than a boolean with a default, and why contracts carries `RedactionDefault` (every field optional) beside `Redaction` (every field required).

A Crop has no Template and walks 1 → 3 → 4.

Resolution happens once, at the gateway door, where the FramingRequest is built and before frame or redact runs. One fact then reaches every Variant candidate, redact, the Call row and the answer, so no two of them can disagree about what was decided.

Field by field, not object by object. A level states what it has an opinion about and stays silent on the rest, so a second field can join the policy later without every level restating the first.

## Decision 2 — which level answered rides on the Framing, and never on the Request Hash

The Framing carries `redaction: { blurUnknownFaces, from }`, and the Call View prints it. `from` is the gateway's account of a decision, not something frame reads — frame is handed the policy on the FramingRequest and has no opinion about where it came from — so it goes on the answer and never on the request.

The consequence is deliberate and is the reason `from` is worth carrying at all: the **Request Hash covers the request as sent**, so a Brand or Template changing its default does not invalidate an Output already made. The next equal request is a Replay and answers the Framing the first call stored, `from` and all. A Brand that has changed its default and wants a fresh Output re-sends with the policy in the request.

Rejected: hashing the resolved policy. It would make every stored Output of every Brand cache-invalid the moment that Brand set a default — a re-render of the whole history to record a preference — and it would make the Request Hash depend on state the request cannot see.

## Decision 3 — a stored policy meco cannot read is a `500`, not a fall-through

Only meco writes the Brand's column, through an Operation that validates against the same schema. A value that then fails to parse is meco's own bug, and the gateway throws rather than treating it as silence.

Falling through would be the safer-looking branch — it lands on `true` unless a Template says otherwise — and that is exactly the shape of failure [ADR-0003](0003-face-recognition-licence-consent-and-threshold.md) records from production: the privacy option failing quietly, on the Brand that needed it. A privacy setting that ignores what it cannot read is worse than one that stops.

## Consequences

- **`brands` gains a nullable `redaction` jsonb column**, stored and returned unread as `calls.framing` is. `brands.ensure` never writes it: the Seed runs on every deploy, and a rename must not undo a policy set over the API.
- **A Template may declare a default.** compose declares it and never applies it — redaction happens on the Source Image long before compose is handed a window. No shipped Template declares one, so today the Template rung is transparent for every real call.
- **compose's `plan`, `render` and `templates` take the Template registry as a parameter**, as `resolve` already did, and `createApp` takes one too. One registry for the catalogue, the Plan and the paint: a catalogue that named Templates the paint could not draw would lie about what a Brand offers. It is also what lets the suite prove the Template rung end to end without shipping a Template nobody asked for.
- **A new Operation, `set_brand_redaction` (`PATCH /v1/brands/:brand`)**, on both Doors, behind the Brand Wall. `{ redaction: { blurUnknownFaces } | null }`, where `null` clears the default. `list_brands` and `list_templates` show what each has set.
- **ADR-0014's Decision 6 still holds.** `true` is still the default and still the side the Brand Wall is on; it is now the last rung of a ladder rather than the only one. Its rejected item "a Brand default anywhere at the door" is reversed by this ADR, and #70's `persons` half of it is not.
