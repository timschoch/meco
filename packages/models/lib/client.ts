// The client the gateway imports. It holds the wire and nothing else: no
// adapter, no session, no decode. `models-client-stays-thin` in
// `.dependency-cruiser.cjs` is what keeps that true.
import { z } from "zod";
import { Annotation } from "@meco/contracts";
import { ERROR_STATUS, type ErrorCode } from "./errors";
import {
  type AnnotateOptions,
  CatalogueEntry,
  ModelsHealth,
  WireError,
} from "./wire";

/**
 * Why a call failed: every code the host puts on the wire, plus the four the
 * client raises on its own. The two sets share no word, so one `code` always
 * says which side refused.
 */
export type ModelsErrorCode =
  | ErrorCode
  /** The call never reached models. */
  | "unreachable"
  /** models did not answer within `timeoutMs`. */
  | "timeout"
  /** models answered something this client cannot vouch for. */
  | "bad_response"
  /** The Annotation names a hash other than the one the caller filed. */
  | "hash_mismatch";

/** Every failure of a `ModelsClient` call, with the code the caller branches on. */
export class ModelsError extends Error {
  constructor(
    readonly code: ModelsErrorCode,
    message: string,
    /** The status that carried it, or `undefined` when no response arrived. */
    readonly status: number | undefined,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ModelsError";
  }
}

/**
 * How the client reaches models. The global `fetch` in production; in a test,
 * `createApp(catalogue).fetch`, which is the same pair without a socket.
 */
export type FetchLike = (request: Request) => Response | Promise<Response>;

export interface ModelsClient {
  /** Annotate the bytes. The Annotation is parsed before it is returned. */
  annotate(bytes: Uint8Array, options?: AnnotateOptions): Promise<Annotation>;
  /** The Catalogue this deployment holds. */
  catalogue(): Promise<CatalogueEntry[]>;
  /** The answering instance's liveness, warmth and memory. */
  health(): Promise<ModelsHealth>;
}

export interface ModelsClientOptions {
  /** Where models answers, e.g. the service binding's URL. */
  baseUrl: string;
  fetch?: FetchLike;
  /**
   * How long one call may take. The default fits a cold instance creating
   * every session in the Catalogue one after another.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Whether a word off the wire is a code this client understands. */
const isWireCode = (code: string): code is ErrorCode => code in ERROR_STATUS;

export function createModelsClient(options: ModelsClientOptions): ModelsClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const call = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * One call: send it, refuse anything that is not a 200 carrying a body this
   * schema parses. Every exit is a `ModelsError`, so a caller never has to
   * tell a `TypeError` from a refusal.
   */
  async function send<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {}
  ): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      // The clock can run out before the call is even made, on a busy process
      // or behind a queue. Ask the signal first, so that case ends as a
      // `timeout` rather than waiting on a fetch that will never be answered.
      signal.throwIfAborted();
      const request = new Request(`${base}${path}`, { ...init, signal });
      // Raced, not merely passed: `timeoutMs` is this client's promise to its
      // caller, and a fetch it was handed is free to ignore a signal.
      response = await Promise.race([
        call(request),
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      ]);
    } catch (cause) {
      // The signal, not the thrown value: an injected fetch is free to reject
      // with whatever it likes, and only the signal knows why it was cut off.
      if (signal.aborted) {
        throw new ModelsError(
          "timeout",
          `models did not answer ${path} within ${timeoutMs}ms`,
          undefined,
          { cause }
        );
      }
      throw new ModelsError(
        "unreachable",
        `models could not be reached at ${base}${path}`,
        undefined,
        { cause }
      );
    }

    const text = await response.text();
    if (!response.ok) throw refusal(path, response.status, text);

    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new ModelsError(
        "bad_response",
        `models answered ${path} with a body that is not JSON`,
        response.status,
        { cause }
      );
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ModelsError(
        "bad_response",
        `models answered ${path} with a body this client cannot parse: ${parsed.error.message}`,
        response.status,
        { cause: parsed.error }
      );
    }
    return parsed.data;
  }

  /**
   * A failure status, as the caller's error. The host's own code is kept when
   * the body carries one; anything else is `bad_response`, because a status
   * without the wire's body did not come from models' own hand.
   */
  function refusal(path: string, status: number, text: string): ModelsError {
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = undefined;
    }
    const wire = WireError.safeParse(body);
    if (wire.success && isWireCode(wire.data.error.code)) {
      return new ModelsError(
        wire.data.error.code,
        wire.data.error.message,
        status
      );
    }
    return new ModelsError(
      "bad_response",
      `models answered ${path} with ${status} and no error body: ${text.slice(0, 200)}`,
      status
    );
  }

  return {
    async annotate(bytes, annotateOptions = {}) {
      const query = annotateOptions.models
        ? `?models=${encodeURIComponent(annotateOptions.models.join(","))}`
        : "";
      const annotation = await send(`/annotate${query}`, Annotation, {
        method: "POST",
        // A copy, so a caller that reuses its buffer cannot change the body
        // out from under an in-flight request.
        body: new Uint8Array(bytes),
      });

      const { hash } = annotateOptions;
      if (hash !== undefined && annotation.hash !== hash) {
        throw new ModelsError(
          "hash_mismatch",
          `models annotated ${annotation.hash}, not the ${hash} it was sent`,
          200
        );
      }
      return annotation;
    },

    catalogue: () => send("/models", z.array(CatalogueEntry)),

    health: () => send("/health", ModelsHealth),
  };
}
