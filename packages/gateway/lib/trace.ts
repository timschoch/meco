/**
 * One Call as it is being made: the Steps so far, what was asked, and the
 * facts the pipeline learns on the way, written to records as one row whether
 * the Call succeeds or fails. A failed Call is recorded before its error is
 * answered (spec, "Errors"); the webui explains a failure by reading the row.
 */
import { ModelsError } from "@meco/models";
import type {
  Call,
  CallError,
  CallKind,
  Caller,
  Records,
  Step,
} from "@meco/records";
import { z } from "zod";
import { GatewayError } from "./errors";

export interface Trace {
  /** Time one stage under `<module>.<verb>`, whether it returns or throws. */
  step<T>(name: string, work: () => Promise<T>): Promise<T>;
  /** A Step measured elsewhere: models' own clock, one per stage. */
  add(step: Step): void;
  /** The wire request with the Source Reference replaced by `{ hash }`. */
  request(request: unknown): void;
  sourceHash(hash: string): void;
  /**
   * The three shapes another module owns, kept on the Call unread: frame's
   * Framing, identify's whole Identification and redact's Redaction Records
   * (records' `calls.ts`). The webui draws a Call from these, and the Face
   * Report on the wire is computed from them rather than stored (ADR-0014).
   */
  framing(framing: unknown): void;
  matches(identification: unknown): void;
  redactions(records: unknown): void;
}

export interface TraceDeps {
  readonly records: Records;
  now(): Date;
}

/** Which module a thrown error belongs to, for the Call's `error.module`. */
function moduleOf(error: unknown): string {
  if (error instanceof ModelsError) return "models";
  if (error instanceof Error) {
    if (error.name === "ComposeError") return "compose";
    if (error.name === "IdentifyError") return "identify";
  }
  return "gateway";
}

function callError(error: unknown): CallError {
  const module = moduleOf(error);
  if (error instanceof GatewayError || error instanceof ModelsError) {
    return { module, code: error.code, message: error.message };
  }
  if (error instanceof z.ZodError) {
    return { module, code: "invalid_request", message: error.message };
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof Error && typeof code === "string") {
    return { module, code, message: error.message };
  }
  return {
    module,
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Run one Call's pipeline and record it. `work` gets the Trace and answers
 * the result; the Call row is written once, after, with `status: ok` or with
 * the error, and the error is rethrown so the Door answers it.
 */
export async function recorded<T>(
  deps: TraceDeps,
  caller: Caller,
  brand: string,
  kind: CallKind,
  work: (trace: Trace) => Promise<T>
): Promise<{ call: Call; result: T }> {
  const startedAt = deps.now();
  const started = performance.now();
  const steps: Step[] = [];
  let request: unknown;
  let sourceHash: string | null = null;
  let framing: unknown;
  let matches: unknown;
  let redactions: unknown;

  const trace: Trace = {
    async step(name, run) {
      const at = performance.now();
      try {
        return await run();
      } finally {
        steps.push({ name, durMs: round(performance.now() - at) });
      }
    },
    add: (step) => {
      steps.push(step);
    },
    request: (given) => {
      request = given;
    },
    sourceHash: (hash) => {
      sourceHash = hash;
    },
    framing: (given) => {
      framing = given;
    },
    matches: (given) => {
      matches = given;
    },
    redactions: (given) => {
      redactions = given;
    },
  };

  const record = (
    status: "ok" | "failed",
    error: CallError | null
  ): Promise<Call> =>
    deps.records.calls.record({
      callerId: caller.id,
      brand,
      kind,
      sourceHash,
      request,
      framing,
      matches,
      redactions,
      steps,
      error,
      status,
      startedAt: startedAt.toISOString(),
      // Whole milliseconds: records keeps the Call's own duration in an
      // integer column, and only the Steps carry tenths.
      durationMs: Math.round(performance.now() - started),
    });

  let result: T;
  try {
    result = await work(trace);
  } catch (error) {
    await record("failed", callError(error));
    throw error;
  }
  return { call: await record("ok", null), result };
}

/** Tenths of a millisecond, as models' `Server-Timing` is written. */
const round = (ms: number): number => Math.round(ms * 10) / 10;
